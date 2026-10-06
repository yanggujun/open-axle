/**
 * db-accessor.ts
 *
 * Database access skill.
 *
 * Executes SQL through the abstraction layer defined in src/db/db.ts. The
 * concrete connection settings are read from .skill.config via getSkillConfig()
 * from src/core/executor.ts, keyed by the database (profile) name supplied in
 * the payload 'database' property.
 *
 * Mirrors the structure and export conventions of the cmd-runner skill:
 *   - _normalize() validates and coerces the incoming property-list payload
 *   - runDbFromPayload() returns an ExecutionResponse on success
 *   - failures are surfaced as plain strings
 *   - exports execute() and ACTION_NAME
 */

import { ExecutionResponse, extractJson, getSequential, getSkillConfig } from '../../core/executor';
import { createDbExecutor } from '../../db/db';
import type { DbConfig, DbType, DbExecutor } from '../../db/db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEWLINE = String.fromCharCode(10);

/** Maps the configured 'type' / 'driver' value onto a DbType. */
const DB_TYPE_ALIASES: Record<string, DbType> = {
  mysql: 'mysql',
  mysql2: 'mysql',
  mariadb: 'mysql',
  pg: 'postgres',
  pgsql: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  mssql: 'mssql',
  sqlserver: 'mssql',
  'sql server': 'mssql',
  tedious: 'mssql',
  oracle: 'oracle',
  oracledb: 'oracle',
  hana: 'hana',
  saphana: 'hana',
  'sap hana': 'hana',
  hdbcli: 'hana',
};

/** Keywords that mutate data or schema; blocked unless allowModification is true. */
const MUTATING_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'truncate',
  'drop',
  'alter',
  'create',
  'grant',
  'revoke',
];

/** System schemas/catalogues that must never be queried. */
const BLOCKED_SCHEMA_FRAGMENTS = [
  'sys.',
  '_sys_',
  'information_schema',
  'performance_schema',
  'pg_catalog',
];

const DEFAULT_TIMEOUT = 30;
const MAX_TIMEOUT = 120;
const DEFAULT_MAX_ROWS = 100;
const MAX_MAX_ROWS = 10000;

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function _toInt(value: any, def: number): number {
  if (value === null || value === undefined || value === '') return def;
  const n = parseInt(String(value).trim(), 10);
  return isNaN(n) ? def : n;
}

function _toBool(value: any, def: boolean): boolean {
  if (value === null || value === undefined || value === '') return def;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

function _str(value: any): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Replace a secret (password) so it never leaks into log lines or error text. */
function _mask(text: string, secret?: string): string {
  const s = (secret ?? '').trim();
  if (!s) return text;
  return text.split(s).join('******');
}

// ---------------------------------------------------------------------------
// SQL analysis & safety
// ---------------------------------------------------------------------------

/** Remove SQL comments so keywords inside comments are not read as code. */
function _stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.substring(i, i + 2);
    if (two === '--' || sql[i] === '#') {
      const nl = sql.indexOf(NEWLINE, i);
      i = nl === -1 ? sql.length : nl;
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return out;
}

/** Collect the mutating keywords present in a token list. */
function _findMutatingKeywords(tokens: string[]): string[] {
  const hits: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (MUTATING_KEYWORDS.indexOf(token) === -1) continue;
    // 'FOR UPDATE' is a row-lock clause inside a SELECT, not a mutation.
    if (token === 'update' && i > 0 && tokens[i - 1] === 'for') continue;
    if (hits.indexOf(token) === -1) hits.push(token);
  }
  return hits;
}

interface SqlAnalysis {
  isWrite: boolean;
  mutating: string[];
  blockedSchema: string | null;
}

function _analyzeSql(sql: string): SqlAnalysis {
  const lower = _stripComments(sql).toLowerCase();

  let blockedSchema: string | null = null;
  for (const fragment of BLOCKED_SCHEMA_FRAGMENTS) {
    if (lower.indexOf(fragment) !== -1) {
      blockedSchema = fragment;
      break;
    }
  }

  const tokens = lower.split(/[^a-z0-9_]+/).filter((t) => t.length > 0);
  const mutating = _findMutatingKeywords(tokens);

  return { isWrite: mutating.length > 0, mutating, blockedSchema };
}

// ---------------------------------------------------------------------------
// Connection configuration (.skill.config)
// ---------------------------------------------------------------------------

function _resolveDbType(raw: Record<string, any>): DbType {
  const candidates = [raw.type, raw.db_type, raw.engine, raw.driver];

  for (const candidate of candidates) {
    const key = _str(candidate).toLowerCase();
    if (!key) continue;
    if (DB_TYPE_ALIASES[key]) return DB_TYPE_ALIASES[key];
  }

  // Substring fallback for decorated driver names (e.g. node-mssql).
  for (const candidate of candidates) {
    const key = _str(candidate).toLowerCase();
    if (!key) continue;
    for (const alias of Object.keys(DB_TYPE_ALIASES)) {
      if (key.indexOf(alias) !== -1) return DB_TYPE_ALIASES[alias];
    }
  }

  throw new Error(
    `Cannot resolve database type from configuration (type=${_str(raw.type)} driver=${_str(raw.driver)}). Supported values: ${Object.keys(DB_TYPE_ALIASES).join(', ')}`,
  );
}

/**
 * Load a named database profile from .skill.config and turn it into a DbConfig.
 *
 * Expected entry shape:
 *   { skill: 'access_db', config_items: [ { name: '<profile>', value: { ... } } ] }
 */
function _loadDbConfig(database: string, baseDir?: string): DbConfig {
  let raw: Record<string, any> = {};

  const found = getSkillConfig("access_db", database);
  if (found && Object.keys(found).length > 0) {
    raw = found as Record<string, any>;
  }

  if (!raw || Object.keys(raw).length === 0) {
    const searched = baseDir && baseDir.trim() ? baseDir.trim() : process.cwd();
    throw new Error(
      `No database configuration found for '${database}' in .skill.config (searched home directory and ${searched})`,
    );
  }

  const type = _resolveDbType(raw);
  const port = _toInt(raw.port ?? raw.port_number, 0);

  const config: DbConfig = {
    type,
    host: _str(raw.host ?? raw.address ?? raw.server ?? raw.host_name) || 'localhost',
    port: port > 0 ? port : undefined,
    user: _str(raw.user_name ?? raw.user ?? raw.username ?? raw.uid),
    password: _str(raw.pass ?? raw.password ?? raw.pwd),
    database: _str(raw.db_name ?? raw.database ?? raw.service_name),
    connectionString: _str(raw.connection_string ?? raw.connect_string) || undefined,
    options: raw.options && typeof raw.options === 'object' ? (raw.options as Record<string, unknown>) : undefined,
  };

  return config;
}

// ---------------------------------------------------------------------------
// Payload validation & normalization
// ---------------------------------------------------------------------------

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? ACTION_NAME;
  const [sequential, nextPromptRaw] = getSequential(payload);

  if (action !== ACTION_NAME) {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  const database = _str(props.database);
  const sql = (props.sql ?? '').toString().trim();
  let timeout = _toInt(props.timeout, DEFAULT_TIMEOUT);
  const allowModification = _toBool(props.allowModification, false);
  let maxRows = _toInt(props.max_rows ?? props.maxRows, DEFAULT_MAX_ROWS);
  const description = _str(props.description);

  if (!database) {
    throw new Error('Missing required field: database');
  }
  if (!sql) {
    throw new Error('Missing required field: sql');
  }

  // Enforce timeout limits (default 30s, max 120s).
  if (timeout < 1) timeout = 1;
  if (timeout > MAX_TIMEOUT) timeout = MAX_TIMEOUT;

  // Cap the result set size (default 100 rows, max 10000 rows).
  if (maxRows < 1) maxRows = DEFAULT_MAX_ROWS;
  if (maxRows > MAX_MAX_ROWS) maxRows = MAX_MAX_ROWS;

  // Safety: never touch system schemas or catalogues.
  const analysis = _analyzeSql(sql);
  if (analysis.blockedSchema) {
    throw new Error(
      `Blocked query: statement references a system schema or table (contains '${analysis.blockedSchema}'); refusing to execute.`,
    );
  }

  // Safety: destructive statements require an explicit opt-in.
  if (analysis.isWrite && !allowModification) {
    throw new Error(
      `Blocked modification statement (${analysis.mutating.join(', ')}). Set allowModification to 'true' to run INSERT/UPDATE/DELETE/MERGE/TRUNCATE/DROP/ALTER/CREATE/GRANT/REVOKE.`,
    );
  }

  let nextPrompt = nextPromptRaw;
  if (sequential && nextPrompt) {
    nextPrompt = `${nextPrompt}\n\n Following is the database execution result:\n\n
`;
  }

  return {
    action,
    database,
    sql,
    timeout,
    allowModification,
    maxRows,
    description,
    isWrite: analysis.isWrite,
    mutating: analysis.mutating,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core database operation
// ---------------------------------------------------------------------------

async function runDbFromPayload(
  payload: string | Record<string, any>,
  baseDir?: string,
): Promise<ExecutionResponse | string> {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  let config: DbConfig;
  try {
    config = _loadDbConfig(data.database, baseDir);
  } catch (e: any) {
    return `Configuration error: ${e.message}`;
  }

  const secret = config.password ?? '';

  let executor: DbExecutor;
  try {
    executor = createDbExecutor(config);
  } catch (e: any) {
    return `Failed to create database executor: ${_mask(e.message, secret)}`;
  }

  try {
    await executor.connect();
  } catch (e: any) {
    return `Failed to connect to database '${data.database}' (type ${config.type}): ${_mask(e.message, secret)}`;
  }

  let out = '';
  try {
    if (data.isWrite) {
      const affected = await executor.nonQuery(data.sql);
      out = `Return code: 0\n\n Database: ${data.database}\n\nType: write (${data.mutating.join(', ')})\n\n Timeout: ${data.timeout}s\n\n Affected rows: ${affected}\n\n`;
    } else {
      const result = await executor.query(data.sql);
      const rows = Array.isArray(result.rows) ? result.rows : [];
      const limited = rows.slice(0, data.maxRows);

      out = `Return code: 0\n\n Database: ${data.database}\n\nType: read timeout: ${data.timeout}s \n\nRow count: ${limited.length}\n\n `;
      if (rows.length > limited.length) {
        out += `Note: result truncated to max_rows=${data.maxRows} (total ${rows.length})\n\n`;
      }
      if (limited.length > 0) {
        const cols = Object.keys(limited[0] as Record<string, unknown>);
        out += `Rows:\n\n| ${cols.join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n`;
        for (const row of limited) {
          const r = row as Record<string, unknown>;
          const cells = cols.map((c) => {
            const s = String(r[c] ?? '');
            return s.length > 50 ? s.slice(0, 50) + '...' : s;
          });
          out += `| ${cells.join(' | ')} |\n`;
        }
        out += '\n';
      } else {
        out += 'Rows: (none)\n\n';
      }
    }
  } catch (e: any) {
    return `Database error: ${_mask(e.message, secret)}`;
  } finally {
    await executor.disconnect().catch(() => undefined);
  }

  const seq = data.sequential;
  const response = new ExecutionResponse(out, data.prompt, seq, !seq, 'json');
  return response;
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillDbAccessorExecute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return runDbFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return skillDbAccessorExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = 'access_db';

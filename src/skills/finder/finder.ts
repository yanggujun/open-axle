import * as fs from 'fs';
import * as path from 'path';
import { Runtime, ExecutionResponse, extractJson, getSequential, buildConnectConfig, connect, execCommand, shellQuote } from '../../common/common';

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const BLOCKED_PATH_FRAGMENTS = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  '/etc/shadow',
  '/etc/passwd',
  '/boot/',
  '/system32',
  '~/.ssh',
  '.ssh/id_rsa',
];

function _isBlockedPath(p: string): string | null {
  const low = p.toLowerCase();
  for (const frag of BLOCKED_PATH_FRAGMENTS) {
    if (low.includes(frag.toLowerCase())) {
      return frag;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

function _toBool(v: any, def: boolean = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (s === '') return def;
  return s === 'true';
}

function _toInt(v: any, def: number): number {
  try {
    const s = String(v).trim();
    if (!s) return def;
    const n = parseInt(s, 10);
    return isNaN(n) ? def : n;
  } catch {
    return def;
  }
}

const DEFAULT_EXCLUDES = '.git,node_modules,__pycache__,.venv,dist,build';

const VALID_ENTRY_TYPES = ['file', 'folder', 'both'];

function _normalizeEntryType(v: any): string {
  let t = String(v ?? 'both').trim().toLowerCase();
  if (t === 'dir' || t === 'directory' || t === 'folders' || t === 'd') return 'folder';
  if (t === 'files' || t === 'f') return 'file';
  if (t === 'all' || t === 'any' || t === 'entries') return 'both';
  if (!VALID_ENTRY_TYPES.includes(t)) return 'both';
  return t;
}

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'find_entry';
  if (action !== 'find_entry') {
    throw new Error(`Unsupported action: ${action}`);
  }

  if (!payload.properties || !Array.isArray(payload.properties)) {
    throw new Error("Missing 'properties' list in payload");
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties) {
    if (p.name !== undefined) props[p.name] = p.value ?? '';
  }

  const pattern = props.pattern ?? '';
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error("Missing required field: 'pattern'");
  }

  const target = ((props.path ?? '') as string).trim() || './';
  const recursive = _toBool(props.recursive ?? 'true', true);
  const isRegex = _toBool(props.isRegex ?? 'false', false);
  const caseSensitive = _toBool(props.caseSensitive ?? 'false', false);
  const entryType = _normalizeEntryType(props.entryType ?? 'both');
  const includeGlob = ((props.includeGlob ?? '') as string).trim() || '*';
  const excludeGlob = ((props.excludeGlob ?? '') as string).trim() || DEFAULT_EXCLUDES;
  let maxResults = _toInt(props.maxResults ?? 100, 100);
  if (maxResults <= 0) maxResults = 100;
  const showPaths = _toBool(props.showPaths ?? 'true', true);

  const [sequential, nextPrompt] = getSequential(payload);
  const excludes = excludeGlob.split(',').map((g: any) => g.toString().trim()).filter(Boolean);

  return {
    action,
    pattern,
    path: target,
    recursive,
    is_regex: isRegex,
    case_sensitive: caseSensitive,
    entry_type: entryType,
    include_glob: includeGlob,
    excludes,
    max_results: maxResults,
    show_paths: showPaths,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Glob / regex helpers
// ---------------------------------------------------------------------------

function _globToRegex(glob: string, caseSensitive: boolean = true): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  const flags = caseSensitive ? '' : 'i';
  return new RegExp(`^${regexStr}$`, flags);
}

function _matchesGlob(name: string, pattern: string, caseSensitive: boolean = true): boolean {
  return _globToRegex(pattern, caseSensitive).test(name);
}

function _matchesAnyGlob(name: string, patterns: string[], caseSensitive: boolean = true): boolean {
  return patterns.some((p: any) => _matchesGlob(name, p, caseSensitive));
}

function _entryNameMatches(basename: string, pattern: string, isRegex: boolean, caseSensitive: boolean): boolean {
  if (isRegex) {
    try {
      const flags = caseSensitive ? '' : 'i';
      return new RegExp(pattern, flags).test(basename);
    } catch {
      return false;
    }
  } else {
    if (caseSensitive) {
      return _matchesGlob(basename, pattern, true);
    } else {
      return _matchesGlob(basename.toLowerCase(), pattern.toLowerCase(), false);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry walking / filtering (files AND folders)
// ---------------------------------------------------------------------------

function* _iterEntries(
  root: string,
  recursive: boolean,
  includeGlob: string,
  excludes: string[],
  entryType: string
): Iterable<{ p: string; isFile: boolean }> {
  // The root itself may be a plain file (only relevant when files are wanted).
  if (entryType !== 'folder' && fs.existsSync(root) && fs.statSync(root).isFile()) {
    yield { p: root, isFile: true };
    return;
  }

  if (!fs.existsSync(root)) return;

  if (recursive) {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (_matchesAnyGlob(entry.name, excludes)) continue;
          if (entryType !== 'file' && _matchesGlob(entry.name, includeGlob)) {
            yield { p: full, isFile: false };
          }
          stack.push(full);
        } else if (entry.isFile()) {
          if (entryType === 'folder') continue;
          if (_matchesAnyGlob(entry.name, excludes)) continue;
          if (!_matchesGlob(entry.name, includeGlob)) continue;
          yield { p: full, isFile: true };
        }
      }
    }
  } else {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(root, name);
      let isFile = false;
      let isDir = false;
      try {
        const st = fs.statSync(full);
        isFile = st.isFile();
        isDir = st.isDirectory();
      } catch {
        continue;
      }
      if (!isFile && !isDir) continue;
      if (isDir && entryType === 'file') continue;
      if (!isDir && entryType === 'folder') continue;
      if (_matchesAnyGlob(name, excludes)) continue;
      if (!_matchesGlob(name, includeGlob)) continue;
      yield { p: full, isFile };
    }
  }
}

// ---------------------------------------------------------------------------
// Core find
// ---------------------------------------------------------------------------

function _wrapResponse(contentJson: string, sequential: any = null, nextPrompt: any = null): ExecutionResponse {
  return new ExecutionResponse(contentJson, nextPrompt, sequential, true);
}

function _errorContentJson(msg: string): string {
  return JSON.stringify({
    action: 'find_entry',
    status: 'error',
    message: msg,
    matches: [],
    totalMatchingEntries: 0,
    entriesScanned: 0,
  }, null, 2);
}

function findEntriesFromPayload(payload: string | Record<string, any>, runtime?: Runtime): ExecutionResponse {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return _wrapResponse(_errorContentJson(`Invalid payload: ${e.message}`));
  }

  const baseDir = runtime?.workingDir?.path || process.cwd();
  const target = data.path;
  const root = path.isAbsolute(target) ? target : path.resolve(baseDir, target);

  const blocked = _isBlockedPath(root);
  if (blocked) {
    return _wrapResponse(_errorContentJson(`Blocked path (contains '${blocked}'); refusing to search.`), data.sequential, data.prompt);
  }

  if (!fs.existsSync(root)) {
    return _wrapResponse(_errorContentJson(`Search path does not exist: ${root}`), data.sequential, data.prompt);
  }

  console.log(`finder: searching '${root}' for pattern='${data.pattern}' (entry_type=${data.entry_type}, regex=${data.is_regex}, case_sensitive=${data.case_sensitive})`);

  const matched: string[] = [];
  let scanned = 0;

  for (const { p } of _iterEntries(root, data.recursive, data.include_glob, data.excludes, data.entry_type)) {
    scanned += 1;
    const basename = path.basename(p);
    if (_entryNameMatches(basename, data.pattern, data.is_regex, data.case_sensitive)) {
      if (data.show_paths) {
        matched.push(path.resolve(p));
      } else {
        matched.push(path.relative(root, p));
      }
      if (matched.length >= data.max_results) break;
    }
  }

  if (matched.length === 0) {
    return _wrapResponse('No matching entries found', data.sequential);
  }

  const entries = matched.join('\n') + '\n';
  return _wrapResponse(entries, data.sequential, data.prompt);
}

// ---------------------------------------------------------------------------
// Remote (SSH) find operation
// ---------------------------------------------------------------------------

async function findEntriesFromPayloadRemote(
  payload: string | Record<string, any>,
  runtime?: Runtime
): Promise<ExecutionResponse> {
  let data: Record<string, any>;
  const baseDir = runtime?.workingDir;
  const serverName = baseDir?.kind === 'remote' ? baseDir.serverName : '';
  const remoteBaseDir = baseDir?.path;
  const server = baseDir?.kind === 'remote' ? baseDir.server : {};
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return _wrapResponse(_errorContentJson(`Invalid payload: ${e.message}`));
  }

  if (!serverName) {
    return _wrapResponse(_errorContentJson('Missing remote server name for SSH execution.'), data.sequential, data.prompt);
  }

  // Resolve the remote search root (the remote host uses POSIX paths).
  const target = data.path;
  const root = path.posix.isAbsolute(target) ? target : path.posix.resolve(remoteBaseDir || '.', target);

  const blocked = _isBlockedPath(root);
  if (blocked) {
    return _wrapResponse(_errorContentJson(`Blocked path (contains '${blocked}'); refusing to search.`), data.sequential, data.prompt);
  }

  const serverCfg = server;
  if (!serverCfg) {
    return _wrapResponse(`No SSH configuration found for server '${serverName}'.`, false);
  }

  const connectConfig = buildConnectConfig(serverName, serverCfg);

  let conn = null as any;
  try {
    conn = await connect(connectConfig);

    // Build a remote `find` command honoring entryType/recursive/excludes.
    const maxDepth = data.recursive ? '' : ' -maxdepth 1';
    let typeFilter = '';
    if (data.entry_type === 'file') {
      typeFilter = ' -type f';
    } else if (data.entry_type === 'folder') {
      typeFilter = ' -type d';
    }
    const cmd = `find ${shellQuote(root)}${maxDepth}${typeFilter} 2>/dev/null`;
    const { stdout } = await execCommand(conn, cmd);

    const matched: string[] = [];
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const epath = line.trim();
      if (!epath) continue;
      // For folders/both, skip the search root itself (mirrors local folder behavior).
      if (data.entry_type !== 'file' && epath === root) continue;

      const segments = epath.split('/').filter(Boolean);
      const basename = segments[segments.length - 1] || '';

      if (_matchesAnyGlob(basename, data.excludes, false)) continue;
      if (segments.some((s: string) => _matchesAnyGlob(s, data.excludes, false))) continue;
      if (!_matchesGlob(basename, data.include_glob)) continue;
      if (!_entryNameMatches(basename, data.pattern, data.is_regex, data.case_sensitive)) continue;

      if (data.show_paths) {
        matched.push(epath);
      } else {
        matched.push(path.posix.relative(root, epath));
      }
      if (matched.length >= data.max_results) break;
    }

    if (matched.length === 0) {
      return _wrapResponse('No matching entries found', data.sequential);
    }

    const entries = matched.join('\n') + '\n';
    return _wrapResponse(entries, data.sequential, data.prompt);
  } catch (e: any) {
    return _wrapResponse(_errorContentJson(`Failed to find remote entries over SSH: ${e.message}`), data.sequential, data.prompt);
  } finally {
    if (conn) {
      try { conn.end(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFinderExecute(jsonPayload: string, runtime?: Runtime): ExecutionResponse {
  return findEntriesFromPayload(jsonPayload, runtime);
}

/**
 * Entry point for finding entries (files and/or folders) on a remote host over
 * SSH. Mirrors skillFinderExecute but targets the configured remote server.
 */
function skillFinderExecuteRemote(
  jsonPayload: string,
  runtime?: Runtime
): Promise<ExecutionResponse> {
  return findEntriesFromPayloadRemote(jsonPayload, runtime);
}

export function execute(jsonPayload: string, runtime: Runtime): ExecutionResponse | Promise<ExecutionResponse> {
  // Navigate the Runtime structure: the resolved working directory lives at
  // runtime.workingDir (kind, serverName, path, server).
  const workingDir = runtime?.workingDir;
  if (workingDir && workingDir.kind === 'remote') {
    return skillFinderExecuteRemote(jsonPayload, runtime);
  }
  return skillFinderExecute(jsonPayload, runtime);
}

export const ACTION_NAME = 'find_entry';

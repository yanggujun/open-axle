
// ---------------------------------------------------------------------------
// Execution response dataclass

import { Client, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
export class ExecutionResponse {
  // Discriminating tag: allows realm-independent structural identification.
  // Using a literal-typed readonly field so it survives across duplicate
  // module copies (e.g. dynamically require()'d skill modules) where
  // `instanceof` would otherwise fail due to differing constructor identity.
  readonly kind = 'execution' as const;

  content: string;
  prompt: string;
  sequential: boolean;
  print: boolean;
  format: string;

  constructor(content: string, prompt: string, sequential: boolean = false, print: boolean = false, format: string = '') {
    this.content = content;
    this.prompt = prompt;
    this.sequential = sequential;
    this.print = print;
    this.format = format;
  }

  /**
   * Structural type guard. Prefer this over `x instanceof ExecutionResponse`.
   *
   * Skill modules are loaded at runtime via createRequire()/require() from the
   * compiled `dist/skills` directory. Those modules resolve their OWN copy of
   * this class, so an object a skill creates with `new ExecutionResponse(...)`
   * has a prototype pointing at a DIFFERENT constructor identity than the one
   * imported in the main bundle. As a result `instanceof` returns false even
   * for a perfectly valid ExecutionResponse. A structural check is immune to
   * this cross-module/realm duplication.
   */
  static isExecutionResponse(x: unknown): x is ExecutionResponse {
    if (x === null || typeof x !== 'object') {
      return false;
    }
    const o = x as Record<string, unknown>;
    return (
      o.kind === 'execution' ||
      (typeof o.content === 'string' &&
        typeof o.prompt === 'string' &&
        typeof o.sequential === 'boolean' &&
        typeof o.print === 'boolean' &&
        typeof o.format === 'string')
    );
  }
}
export function extractJson(payload: string | Record<string, any>): Record<string, any> | null {
  if (typeof payload === 'object' && payload !== null) {
    return payload;
  }
  if (typeof payload !== 'string') {
    return null;
  }

  let text = payload.trim();
  const match = FENCE_RE.exec(text);
  if (match) {
    text = match[1].trim();
  }
  if (!text.startsWith('{')) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.substring(firstBrace, lastBrace + 1);
    }
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      properties: [
        {
          name: 'output',
          value: text
        }
      ]
    };
  }
}
// ---------------------------------------------------------------------------
// Sequential and execution helpers
// ---------------------------------------------------------------------------

export function getSequential(payload: Record<string, any>): [boolean, string] {
  const seq = payload.sequential;
  let sequential = false;
  let nextPrompt = '';
  if (seq) {
    sequential = true;
    const prmt = seq.prompt;
    if (prmt) {
      nextPrompt = prmt;
    }
  }
  return [sequential, nextPrompt];
}
/**
 * Translate a resolved skill-config server entry into an ssh2 ConnectConfig,
 * supporting both password and private-key authentication.
 */

export function buildConnectConfig(serverName: string, server: Record<string, string>): ConnectConfig {
  const host = server.host || serverName;
  const portRaw = server.port ? parseInt(server.port, 10) : SSH_DEFAULT_PORT;
  const username = server.user_name || server.userName || server.user || '';
  const authType = (server.auth_type || server.authType || '').toLowerCase();

  const config: ConnectConfig = {
    host,
    port: isNaN(portRaw) ? SSH_DEFAULT_PORT : portRaw,
    username,
    readyTimeout: 20000,
  };

  const keyFile = server.key_file || server.keyFile;
  if (authType === 'key' && keyFile) {
    try {
      config.privateKey = fs.readFileSync(keyFile);
      if (server.pass) {
        config.passphrase = server.pass;
      }
    } catch {
      // Defer to connect() to surface the auth/read error.
    }
  } else if (server.pass) {
    config.password = server.pass;
  } else if (keyFile) {
    try {
      config.privateKey = fs.readFileSync(keyFile);
    } catch {
      // Defer to connect() to surface the error.
    }
  }

  return config;
}
/** Establish an ssh2 connection and resolve once the client is 'ready'. */

export function connect(config: ConnectConfig): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err: Error) => reject(err));
    try {
      conn.connect(config);
    } catch (e: any) {
      reject(e);
    }
  });
}
/** Run a command over an existing ssh2 client, returning its exit code and stdout. */

export function execCommand(conn: Client, cmd: string): Promise<{ code: number; stdout: string; }> {
  return new Promise<{ code: number; stdout: string; }>((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        resolve({ code: 1, stdout: '' });
        return;
      }
      let stdout = '';
      let code = 0;
      stream.on('close', (c: number) => {
        code = typeof c === 'number' ? c : 0;
        resolve({ code, stdout });
      });
      stream.on('data', (d: Buffer) => { stdout += d.toString(); });
      stream.on('error', () => resolve({ code: 1, stdout }));
    });
  });
}
/** Minimal single-quote shell escaping for remote path/argument safety. */

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
/** Open an SFTP session over an existing ssh2 client. */

export function getSftp(conn: Client): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}
/** Promisified SFTP stat. */

export function sftpStat(sftp: any, remotePath: string): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    sftp.stat(remotePath, (err: any, stats: any) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}
/** Promisified SFTP readFile (utf-8). */

export function sftpReadFile(sftp: any, remotePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sftp.readFile(remotePath, (err: any, data: Buffer) => {
      if (err) reject(err);
      else resolve(data.toString('utf8'));
    });
  });
}
/** Promisified SFTP writeFile. */

export function sftpWriteFile(sftp: any, remotePath: string, content: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.writeFile(remotePath, content, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
/** Promisified recursive SFTP mkdir (errors ignored: dir may already exist). */

export function sftpMkdir(sftp: any, remotePath: string): Promise<void> {
  return new Promise<void>((resolve) => {
    sftp.mkdir(remotePath, { recursive: true }, () => {
      resolve();
    });
  });
}
/** Return true when the remote path exists and is a regular file. */

export async function remoteFileExists(sftp: any, remotePath: string): Promise<boolean> {
  try {
    const stats = await sftpStat(sftp, remotePath);
    return stats.isFile();
  } catch {
    return false;
  }
}
/** Best-effort check whether a remote file is tracked in a git repository. */

export async function remoteIsInGitRepo(conn: Client, dir: string, filePath: string): Promise<boolean> {
  const ver = await execCommand(conn, 'git --version');
  if (ver.code !== 0) {
    return false;
  }
  const top = await execCommand(conn, `cd ${shellQuote(dir)} && git rev-parse --show-toplevel`);
  if (top.code !== 0) {
    return false;
  }
  const ls = await execCommand(conn, `cd ${shellQuote(dir)} && git ls-files --error-unmatch ${shellQuote(filePath)}`);
  return ls.code === 0;
}
/**
 * Reads a file given its path and, if the file extension corresponds to a
 * known code format, wraps the file content with a markdown code fence using
 * the appropriate language tag and returns the fenced content.
 *
 * @param filePath The path of the file to read.
 * @returns The file content wrapped in a code fence (with the language tag) if
 *          the extension is a known code format; otherwise an empty string.
 */

export function readFile(filePath: string, startLine: number = 0, endLine: number = 0, maxBytes: number = 0): string {
  const ext = path.extname(filePath).toLowerCase();
  const language = CODE_EXTENSION_LANGUAGE_MAP[ext];

  let content: string;
  try {
    if (endLine > 0 || startLine > 1) {
      // Line-range read.
      const full = fs.readFileSync(filePath, 'utf-8');
      const lines = full.split(/\r?\n/);
      const start = Math.max(1, startLine);
      const end = endLine > 0 ? endLine : lines.length;
      const endIdx = Math.min(end, lines.length);
      content = lines.slice(start - 1, endIdx).join('\n');
    } else if (maxBytes > 0) {
      content = fs.readFileSync(filePath, 'utf-8').substring(0, maxBytes);
    } else {
      content = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }

  if (!language) {
    // Not a known code format: return the raw file content directly.
    return content;
  }

  return '```' + language + '\n' + content + '\n```';
}
// ---------------------------------------------------------------------------
// Code file reading with code-fence wrapping
// ---------------------------------------------------------------------------
// Mapping of known code file extensions to the markdown code-fence language tag.

export const CODE_EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.java': 'java',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.c': 'c',
  '.py': 'python',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sh': 'bash',
  '.json': 'json',
  '.xml': 'xml',
  '.html': 'html',
  '.css': 'css',
  '.sql': 'sql',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};
// ---------------------------------------------------------------------------
// JSON payload parsing (property-list format)
// ---------------------------------------------------------------------------
export const FENCE_RE = /```(?:[a-zA-Z0-9_\-]+)?\s*\n([\s\S]*?)\n```/;
// ---------------------------------------------------------------------------
// Shared SSH helpers (used by remote-capable skills such as cmd-runner and
// file-changer). Centralized here to avoid duplication across skill modules.
// ---------------------------------------------------------------------------

export const SSH_DEFAULT_PORT = 22;
/** Matches the leading `ssh://` scheme, case-insensitively. */
export const SSH_SCHEME = /^ssh:\/\//i;
/**
 * Unified representation of the agent's current working directory, produced
 * by {@link parsePath} and cached by {@link AxleAgent}.
 *
 * - `remote`: the working directory lives on a server reached over SSH. The
 *   original `ssh://<serverName>/<remotePath>` input is decomposed into:
 *     - `serverName`: the server host/alias as written in the URL (kept so a
 *       string form of the working directory remains reconstructible, since
 *       it is NOT derivable from the resolved config object);
 *     - `path`: the normalized, absolute remote path;
 *     - `server`: the resolved skill-config `value` object (host, port,
 *       user_name, auth_type, ...) looked up from the 'ssh' skill with an
 *       'scp' fallback, or `null` when no matching server config was found.
 * - `local`: an ordinary local filesystem path (absolute or relative).
 */

export type WorkingDir =
  { kind: 'remote'; serverName: string; path: string; server: Record<string, string> | null; } |
  { kind: 'local'; path: string; };
/**
 * A single `{ name, value }` configuration item inside a skill entry of the
 * `.skill.config` file, exactly the shape consumed by {@link getSkillConfig}.
 */

export interface SkillConfigItem {
  name: string;
  value: Record<string, string>;
}
/**
 * One skill entry from the `.skill.config` file: a skill name plus ALL of its
 * configuration items.
 */

export interface SkillConfigEntry {
  skill: string;
  config_items: SkillConfigItem[];
}
/**
 * Holds ALL skill configs from the `.skill.config` file (every skill entry
 * together with all of its `config_items`), unlike {@link getSkillConfig}
 * which resolves only one skill's config item value.
 */

export interface FullSkillConfig {
  skill_configs: SkillConfigEntry[];
}
/**
 * Runtime context for the agent.
 *
 * - `workingDir`: the resolved working directory (see {@link WorkingDir}).
 * - `fullSkillConfig`: ALL skill configs from `.skill.config`, not just the
 *   single item value returned by {@link getSkillConfig}.
 */

export type Runtime = {
  workingDir: WorkingDir;
  fullSkillConfig: FullSkillConfig;
};


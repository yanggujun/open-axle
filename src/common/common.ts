
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
  mimeType: string;

  constructor(content: string, prompt: string, sequential: boolean = false, print: boolean = false, format: string = '', mimeType: string = '') {
    this.content = content;
    this.prompt = prompt;
    this.sequential = sequential;
    this.print = print;
    this.format = format;
    this.mimeType = mimeType;
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
/** Mapping of common text/code extensions to a MIME type (default 'text/plain'). */
export const TEXT_EXTENSION_MIME_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.dtd': 'application/xml',
  '.xsd': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.svg': 'image/svg+xml'
};

/**
 * Mapping of PURE-TEXT file extensions (plain prose / logs / config with no
 * dedicated code-fence language) to a MIME type. These files carry no syntax
 * highlighting and are read as-is; CSV/TSV are additionally rendered as a
 * markdown table (see {@link delimitedToMarkdownTable}).
 */
export const PURE_TEXT_EXTENSION_MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.properties': 'text/plain',
  '.env': 'text/plain',
  '.toml': 'text/plain',
  '.rst': 'text/x-rst',
  '.nfo': 'text/plain',
  '.list': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff'
};

/**
 * Unified result of reading a file, shared by both {@link readFile} (text/code)
 * and {@link readImageFile} (images).
 *
 * - For text/code files `content` holds the file's text (code-fenced when the
 *   extension is a known code format) and `uri` is a `data:` URI of that text.
 * - For image files `content` holds the raw base64 string and `uri` is a
 *   ready-to-embed `data:` URI.
 */
export interface FileReadResult {
  /** Primary payload: text file -> text content; image file -> base64 string. */
  content: string;
  /** Detected format name (e.g. 'typescript', 'png', 'jpeg', 'svg'). */
  format: string;
  /** MIME type (e.g. 'text/plain', 'image/png', 'image/svg+xml'). */
  mimeType: string;
}

/** Number of leading bytes inspected when sniffing an unknown file type. */
const TEXT_SNIFF_BYTES = 8192;

/**
 * Heuristically decides whether a file (typically with an UNKNOWN extension)
 * is a text file. Reads a leading byte chunk and rejects it when it contains
 * NUL bytes (a strong binary signal) or too many undecodable / non-printable
 * bytes.
 *
 * @param filePath The path of the file to inspect.
 * @returns true when the file looks like text; false otherwise.
 */
export function isProbablyTextFile(filePath: string): boolean {
  let buf: Buffer;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunk = Buffer.alloc(TEXT_SNIFF_BYTES);
      const read = fs.readSync(fd, chunk, 0, TEXT_SNIFF_BYTES, 0);
      buf = chunk.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }

  return isProbablyTextBuffer(buf);
}

/** Splits a single delimited (CSV/TSV) line into fields, honoring quotes. */
export function parseDelimitedLine(line: string, delim: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Escapes a cell value for safe inclusion in a markdown table. */
export function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Renders delimited text (CSV/TSV) as a GitHub-flavored markdown table. The
 * first row is treated as the header; column counts are normalized so ragged
 * rows still produce a valid table.
 */
export function delimitedToMarkdownTable(text: string, delim: string): string {
  const rows = text.split(/\r?\n/);
  // Drop a single trailing empty row (files usually end with a newline).
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') {
    rows.pop();
  }
  if (rows.length === 0) {
    return '';
  }
  const parsed = rows.map((r) => parseDelimitedLine(r, delim));
  const colCount = parsed.reduce((max, r) => Math.max(max, r.length), 0);
  const pad = (r: string[]): string[] => {
    const out = r.slice();
    while (out.length < colCount) out.push('');
    return out;
  };
  const header = pad(parsed[0]);
  const body = parsed.slice(1).map(pad);
  const lines: string[] = [];
  lines.push('| ' + header.map(escapeMarkdownCell).join(' | ') + ' |');
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
  for (const row of body) {
    lines.push('| ' + row.map(escapeMarkdownCell).join(' | ') + ' |');
  }
  return lines.join('\n');
}

/**
 * Slices already-read text according to the shared line-range / maxBytes
 * semantics used by BOTH the local and remote read paths.
 */
export function sliceText(text: string, startLine: number = 0, endLine: number = 0, maxBytes: number = 0): string {
  if (endLine > 0 || startLine > 1) {
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, startLine);
    const end = endLine > 0 ? endLine : lines.length;
    const endIdx = Math.min(end, lines.length);
    return lines.slice(start - 1, endIdx).join('\n');
  }
  if (maxBytes > 0) {
    return text.substring(0, maxBytes);
  }
  return text;
}

/**
 * Builds a {@link FileReadResult} from already-read text for a file with the
 * given extension. Known code formats are wrapped in a markdown code fence;
 * CSV/TSV files are rendered as a markdown table.
 */
export function buildTextContentResult(ext: string, text: string): FileReadResult {
  const language = CODE_EXTENSION_LANGUAGE_MAP[ext] || '';

  let content: string;
  let format: string;
  if (ext === '.csv' || ext === '.tsv') {
    const delim = ext === '.tsv' ? '\t' : ',';
    content = delimitedToMarkdownTable(text, delim);
    format = 'markdown';
  } else if (ext === '.svg') {
    content = text;
    format = "svg";
  } else {
    content = '```' + language + '\n' + text + '\n```';
    format = language;
  }

  const mimeType = TEXT_EXTENSION_MIME_MAP[ext] || PURE_TEXT_EXTENSION_MIME_MAP[ext] || 'text/plain';
  return {
    content,
    format,
    mimeType
  };
}

/**
 * Builds a {@link FileReadResult} from an already-read image buffer. `content`
 * holds the raw base64 string and `uri` a ready-to-embed data URI. Throws when
 * the extension is not a recognized image format.
 */
export function buildImageContentResult(ext: string, buffer: Buffer): FileReadResult {
  const meta = IMAGE_EXTENSION_MIME_MAP[ext];
  if (!meta) {
    throw new Error(`Unsupported image format: ${ext || '(no extension)'}`);
  }
  const base64 = buffer.toString('base64');
  return {
    content: base64,
    format: 'image',
    mimeType: meta.mimeType
  };
}

/** Heuristically decides whether an already-read buffer looks like text. */
export function isProbablyTextBuffer(buf: Buffer): boolean {
  if (buf.length === 0) {
    return true;
  }
  if (buf.includes(0)) {
    return false;
  }
  const decoded = buf.toString('utf-8');
  let bad = 0;
  for (const ch of decoded) {
    if (ch === '\uFFFD') {
      bad++;
    }
  }
  return decoded.length > 0 && bad / decoded.length < 0.1;
}

/**
 * Buffer-based, file-type aware dispatcher shared by the local and remote read
 * paths. Mirrors {@link readFile} but works on an already-read buffer so the
 * very same logic runs against content fetched over SFTP.
 *
 *   1. image extension     -> {@link buildImageContentResult};
 *   2. known text/code ext -> {@link buildTextContentResult} (after slicing);
 *   3. unknown extension   -> sniff: text -> buildTextContentResult; binary
 *                             -> not supported yet.
 */
export function buildFileResultFromBuffer(ext: string, buffer: Buffer, startLine: number = 0, endLine: number = 0, maxBytes: number = 0): FileReadResult {
  // 1) Image files -> base64 result.
  if (IMAGE_EXTENSION_MIME_MAP[ext]) {
    return buildImageContentResult(ext, buffer);
  }

  // 2) Known text/code formats (code languages, structured text, pure text).
  if (CODE_EXTENSION_LANGUAGE_MAP[ext] || TEXT_EXTENSION_MIME_MAP[ext] || PURE_TEXT_EXTENSION_MIME_MAP[ext]) {
    const text = sliceText(buffer.toString('utf-8'), startLine, endLine, maxBytes);
    return buildTextContentResult(ext, text);
  }

  // 3) Unknown extension: sniff the content to decide if it is text.
  if (isProbablyTextBuffer(buffer)) {
    const text = sliceText(buffer.toString('utf-8'), startLine, endLine, maxBytes);
    return buildTextContentResult(ext, text);
  }

  // 4) Binary / unknown format: not supported yet.
  // TODO: implement binary file handling here when needed.
  throw new Error(`Unsupported (binary) file format: ${ext || '(no extension)'}`);
}

/** Promisified SFTP readFile returning the raw bytes as a Buffer. */
export function sftpReadFileBuffer(sftp: any, remotePath: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    sftp.readFile(remotePath, (err: any, data: Buffer) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/**
 * Reads a text/code file. Known code formats are wrapped in a markdown code
 * fence; CSV/TSV files are rendered as a markdown table. This is the
 * low-level text reader; {@link readFile} is the file-type aware entry point
 * that dispatches here for text/code files.
 *
 * @param filePath The path of the file to read.
 * @returns A {@link FileReadResult} with the `content`, the detected `format`
 *          (code-fence language tag, or 'markdown' for CSV/TSV tables), the
 *          `mimeType` and a `uri`.
 */
export function readTextFile(filePath: string, startLine: number = 0, endLine: number = 0, maxBytes: number = 0): FileReadResult {
  const ext = path.extname(filePath).toLowerCase();

  let fullText: string;
  try {
    fullText = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error}`);
  }

  return buildTextContentResult(ext, sliceText(fullText, startLine, endLine, maxBytes));
}

/**
 * Single entry point to read a file. Dispatches on the file type:
 *   1. image extensions      -> {@link readImageFile} (base64 result);
 *   2. known text/code exts  -> {@link readTextFile};
 *   3. unknown extensions    -> sniff the content: text files go to
 *                               {@link readTextFile}; binary files are not
 *                               supported yet.
 *
 * @param filePath  The path of the file to read.
 * @param startLine 1-based start line (text files only).
 * @param endLine   1-based inclusive end line (text files only).
 * @param maxBytes  Maximum bytes to read (text files only).
 * @returns A unified {@link FileReadResult}.
 */
export function readFile(filePath: string, startLine: number = 0, endLine: number = 0, maxBytes: number = 0): FileReadResult {
  const ext = path.extname(filePath).toLowerCase();

  // 1) Image files -> base64 result.
  if (IMAGE_EXTENSION_MIME_MAP[ext]) {
    return readImageFile(filePath);
  }

  // 2) Known text/code formats (code languages, structured text, pure text).
  if (CODE_EXTENSION_LANGUAGE_MAP[ext] || TEXT_EXTENSION_MIME_MAP[ext] || PURE_TEXT_EXTENSION_MIME_MAP[ext]) {
    return readTextFile(filePath, startLine, endLine, maxBytes);
  }

  // 3) Unknown extension: sniff the content to decide if it is text.
  if (isProbablyTextFile(filePath)) {
    return readTextFile(filePath, startLine, endLine, maxBytes);
  }

  // 4) Binary / unknown format: not supported yet.
  // TODO: implement binary file handling here when needed.
  throw new Error(`Unsupported (binary) file format for ${filePath}: ${ext || '(no extension)'}`);
}
// ---------------------------------------------------------------------------
// Image file reading (base64)
// ---------------------------------------------------------------------------

/**
 * Mapping of known image file extensions to their canonical format name and
 * MIME type.
 */
export const IMAGE_EXTENSION_MIME_MAP: Record<string, { format: string; mimeType: string; }> = {
  '.png': { format: 'png', mimeType: 'image/png' },
  '.apng': { format: 'apng', mimeType: 'image/apng' },
  '.jpg': { format: 'jpeg', mimeType: 'image/jpeg' },
  '.jpeg': { format: 'jpeg', mimeType: 'image/jpeg' },
  '.jpe': { format: 'jpeg', mimeType: 'image/jpeg' },
  '.jfif': { format: 'jpeg', mimeType: 'image/jpeg' },
  '.gif': { format: 'gif', mimeType: 'image/gif' },
  '.bmp': { format: 'bmp', mimeType: 'image/bmp' },
  '.webp': { format: 'webp', mimeType: 'image/webp' },
  '.tif': { format: 'tiff', mimeType: 'image/tiff' },
  '.tiff': { format: 'tiff', mimeType: 'image/tiff' },
  '.ico': { format: 'ico', mimeType: 'image/x-icon' },
  '.cur': { format: 'ico', mimeType: 'image/x-icon' },
  '.avif': { format: 'avif', mimeType: 'image/avif' },
  '.heic': { format: 'heic', mimeType: 'image/heic' },
  '.heif': { format: 'heif', mimeType: 'image/heif' }
};


/**
 * Reads an image file into a base64 string together with its detected format.
 *
 * Returns the shared {@link FileReadResult}: `content` holds the raw base64
 * string, `format`/`mimeType` describe the image, and `uri` is a ready-to-use
 * `data:` URI.
 *
 * Supports the most popular raster image formats (png, jpeg, gif, bmp, webp,
 * tiff, ico, avif, heic/heif, apng). SVG is intentionally NOT handled here:
 * it is an XML text format and is read as plain text by {@link readFile} (and
 * {@link buildFileResultFromBuffer} for remote files).
 *
 * @param filePath The path of the image file to read.
 * @returns A {@link FileReadResult} containing the base64 `content`, the
 *          canonical `format`, the `mimeType`, and a data `uri`.
 * @throws Error if the extension is not a recognized image format or the file
 *         cannot be read.
 */
export function readImageFile(filePath: string): FileReadResult {
  const ext = path.extname(filePath).toLowerCase();
  const meta = IMAGE_EXTENSION_MIME_MAP[ext];
  if (!meta) {
    throw new Error(`Unsupported image format for file ${filePath}: ${ext || '(no extension)'}`);
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`Failed to read image file ${filePath}: ${error}`);
  }

  const base64 = buffer.toString('base64');
  return {
    content: base64,
    format: 'image',
    mimeType: meta.mimeType
  };
}

export function buildImageUri(mimeType: string, base64: string) {
  return `data:${mimeType};base64,${base64}`;
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
  '.dtd': 'xml',
  '.xsd': 'xml',
  '.svg': 'xml'
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

export function fenceCode(lang: string, code: string) {
  return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
}
import * as fs from 'fs';
import * as path from 'path';
import { Runtime, ExecutionResponse, extractJson, getSequential, readFile, buildConnectConfig, connect, getSftp, sftpReadFileBuffer, buildFileResultFromBuffer } from '../../common/common';

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
  const low = p.replace(/\\/g, '\\').toLowerCase();
  for (const frag of BLOCKED_PATH_FRAGMENTS) {
    if (low.includes(frag.toLowerCase())) {
      return frag;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload validation & normalization
// ---------------------------------------------------------------------------

function _toInt(value: any, def: number): number {
  if (value === null || value === undefined || value === '') return def;
  const n = parseInt(String(value).trim(), 10);
  return isNaN(n) ? def : n;
}

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'read_file';
  const [sequential, nextPromptRaw] = getSequential(payload);

  if (action !== 'read_file') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  let filePath = (props.filePath ?? '').toString();
  let filename = (props.fileName ?? '').toString();
  const encoding = (props.encoding ?? 'utf-8').toString() || 'utf-8';
  let maxBytes = _toInt(props.maxBytes, 0);
  let startLine = _toInt(props.startLine, 1);
  let endLine = _toInt(props.endLine, 0);

  if (!filePath && !filename) {
    throw new Error("Must provide 'filePath' and/or 'fileName'");
  }

  if (!filePath) {
    filePath = './';
  }

  // If file_path already looks like it includes a filename, split it.
  const base = path.basename(filePath);
  if (base && base.includes('.') && !filename) {
    filename = base;
    filePath = path.dirname(filePath) || './';
  }

  if (!filename) {
    throw new Error("Missing required field: 'fileName'");
  }

  // Basic sanity checks on filename.
  if (/[\n\r\0]/.test(filename)) {
    throw new Error('Invalid characters in filename');
  }

  if (startLine < 1) startLine = 1;
  if (endLine < 0) endLine = 0;

  let nextPrompt = nextPromptRaw;

  return {
    action,
    file_path: filePath,
    filename,
    encoding,
    max_bytes: maxBytes,
    start_line: startLine,
    end_line: endLine,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core read-file operation
// ---------------------------------------------------------------------------

function readFileFromPayload(payload: string | Record<string, any>, runtime?: Runtime): ExecutionResponse | string {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return new ExecutionResponse(`Invalid payload: ${e.message}`, '', true, true);
  }

  const baseDir = runtime?.workingDir?.path || process.cwd();
  const targetDir = data.file_path;

  // Resolve target path.
  let fullDir: string;
  if (path.isAbsolute(targetDir)) {
    fullDir = targetDir;
  } else {
    fullDir = path.resolve(baseDir, targetDir);
  }

  const fullPath = path.resolve(fullDir, data.filename);

  // Safety check.
  const blocked = _isBlockedPath(fullPath);
  if (blocked) {
    return `Blocked path (contains '${blocked}'); refusing to read.`;
  }

  // Existence & type checks.
  if (!fs.existsSync(fullPath)) {
    return new ExecutionResponse(
      `FILE NOT FOUND: ${fullPath}, PLEASE FIND THE FILE FIRST`,
      '',
      true,
      false
    );
  }
  if (!fs.statSync(fullPath).isFile()) {
    return `Path is not a regular file: ${fullPath}`;
  }

  // Read the file. readFile returns a unified FileReadResult (the same shape
  // as readImageFile): `content` is the fenced text, `format` is the detected
  // code-fence language tag.
  let readResult: ReturnType<typeof readFile>;
  try {
    readResult = readFile(fullPath, data.start_line, data.end_line, data.max_bytes);
  } catch (e: any) {
    return `Failed to read file: ${e.message}`;
  }
  const content = readResult.content;

  const seq = data.sequential;
  let nextPrompt = data.prompt;
  if (seq && data.prompt) {
    nextPrompt = `${data.prompt}\n\nFollowing is the content of file ${fullPath}:\n\n`;
  }
  return new ExecutionResponse(content, nextPrompt, seq, !seq, readResult.format, readResult.mimeType);
}

// ---------------------------------------------------------------------------
// Remote (SSH) read-file operation
// ---------------------------------------------------------------------------

async function readFileFromPayloadRemote(
  payload: string | Record<string, any>,
  runtime?: Runtime
): Promise<ExecutionResponse | string> {
  let data: Record<string, any>;
  const baseDir = runtime?.workingDir;
  const serverName = baseDir?.kind === 'remote' ? baseDir.serverName : '';
  const remoteBaseDir = baseDir?.path;
  const server = baseDir?.kind === 'remote' ? baseDir.server : {};
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  if (!serverName) {
    return 'Missing remote server name for SSH execution.';
  }

  // Resolve the target remote path (the remote host uses POSIX paths).
  const targetDir = data.file_path;
  const fullDir = path.posix.isAbsolute(targetDir)
    ? targetDir
    : path.posix.resolve(remoteBaseDir || '.', targetDir);
  const fullPath = path.posix.resolve(fullDir, data.filename);

  const blocked = _isBlockedPath(fullPath);
  if (blocked) {
    return `Blocked path (contains '${blocked}'); refusing to read.`;
  }

  const serverCfg = server;
  if (!serverCfg) {
    return `No SSH configuration found for server '${serverName}'.`;
  }

  const connectConfig = buildConnectConfig(serverName, serverCfg);

  let conn = null as any;
  try {
    conn = await connect(connectConfig);
    const sftp = await getSftp(conn);

    let buffer: Buffer;
    try {
      buffer = await sftpReadFileBuffer(sftp, fullPath);
    } catch {
      return new ExecutionResponse(
        `FILE NOT FOUND: ${fullPath}, PLEASE FIND THE FILE FIRST`,
        data.prompt,
        true,
        false
      );
    }

    // Use the SAME file-type aware logic as the local path (shared via
    // common.ts): images -> base64, code -> code fence, CSV/TSV -> markdown
    // table, unknown text -> text, binary -> not supported yet.
    const extWithDot = path.posix.extname(fullPath).toLowerCase();
    let readResult: ReturnType<typeof buildFileResultFromBuffer>;
    try {
      readResult = buildFileResultFromBuffer(extWithDot, buffer, data.start_line, data.end_line, data.max_bytes);
    } catch (e: any) {
      return `Failed to read remote file: ${e.message}`;
    }

    const seq = data.sequential;
    let nextPrompt = data.prompt;
    if (seq && data.prompt) {
      nextPrompt = `${data.prompt}\n\nFollowing is the content of file ${fullPath}:\n\n`;
    }
    return new ExecutionResponse(readResult.content, nextPrompt, seq, !seq, readResult.format, readResult.mimeType);
  } catch (e: any) {
    return `Failed to read remote file over SSH: ${e.message}`;
  } finally {
    if (conn) {
      try { conn.end(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFileReaderExecute(jsonPayload: string, runtime?: Runtime): ExecutionResponse | string {
  return readFileFromPayload(jsonPayload, runtime);
}

/**
 * New entry point: read a file on a remote host over SSH. Mirrors
 * skillFileReaderExecute but targets the configured remote server.
 */
function skillFileReaderExecuteRemote(
  jsonPayload: string,
  runtime?: Runtime
): Promise<ExecutionResponse | string> {
  return readFileFromPayloadRemote(jsonPayload, runtime);
}

export function execute(jsonPayload: string, runtime: Runtime): ExecutionResponse | string | Promise<ExecutionResponse | string> {
  // Navigate the Runtime structure: the resolved working directory lives at
  // runtime.workingDir (kind, serverName, path, server).
  const workingDir = runtime?.workingDir;
  if (workingDir && workingDir.kind === 'remote') {
    return skillFileReaderExecuteRemote(jsonPayload, runtime);
  }
  return skillFileReaderExecute(jsonPayload, runtime);
}

export const ACTION_NAME = "read_file";
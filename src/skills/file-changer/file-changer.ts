import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ExecutionResponse, extractJson, getSequential, buildConnectConfig, connect, getSftp, sftpReadFile, sftpWriteFile, sftpMkdir, remoteFileExists, remoteIsInGitRepo, Runtime } from '../../common/common';
import { Client } from 'ssh2';

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const BLOCKED_PATH_FRAGMENTS = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  '/etc/',
  '/bin/',
  '/sbin/',
  '/usr/bin/',
  '/usr/sbin/',
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

const VALID_OPERATIONS = new Set([
  'replace_all',
  'append',
  'prepend',
  'replace_text',
  'insert_at_line',
  'delete_lines',
]);

// ---------------------------------------------------------------------------
// Payload validation & normalization
// ---------------------------------------------------------------------------

function _toBool(v: any, def: boolean = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return def;
  return String(v).trim().toLowerCase() === 'true';
}

function _toInt(v: any, field: string): number {
  const n = parseInt(String(v).trim(), 10);
  if (isNaN(n)) {
    throw new Error(`Field '${field}' must be an integer, got ${v}`);
  }
  return n;
}

function _splitLinesKeepEnds(text: string): string[] {
  return text.match(/.*(?:[\r\n]+|$)/g) || [];
}

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'change_file';
  if (action !== 'change_file') {
    throw new Error(`Unsupported action: ${action}`);
  }

  if (!payload.properties || !Array.isArray(payload.properties)) {
    throw new Error("Missing 'properties' list in payload");
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties) {
    if (p.name !== undefined) {
      props[p.name] = p.value ?? '';
    }
  }

  let filePath = (props.filePath ?? '').toString().trim();
  let filename = (props.fileName ?? '').toString().trim();
  const operation = (props.operation ?? '').toString().trim();
  const encoding = (props.encoding ?? '').toString().trim() || 'utf-8';
  const createIfMissing = _toBool(props.createIfMissing, false);
  const backup = _toBool(props.backup, false);
  const content = props.content ?? '';
  const search = props.search ?? '';
  const replacement = props.replacement ?? '';
  let lineNumber = props.lineNumber ?? '';
  let startLine = props.startLine ?? '';
  let endLine = props.endLine ?? '';

  const [sequential, nextPrompt] = getSequential(payload);

  if (!VALID_OPERATIONS.has(operation)) {
    throw new Error(`Invalid operation ${operation}. Must be one of: ${Array.from(VALID_OPERATIONS).sort()}`);
  }

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

  if (/[\n\r\0]/.test(filename)) {
    throw new Error('Invalid characters in filename');
  }

  // Operation-specific validation.
  if (['replace_all', 'append', 'prepend'].includes(operation)) {
    if (content === null || content === undefined) {
      throw new Error(`Operation '${operation}' requires 'content'`);
    }
  } else if (operation === 'replace_text') {
    if (!search) {
      throw new Error("Operation 'replace_text' requires non-empty 'search'");
    }
  } else if (operation === 'insert_at_line') {
    if (content === null || content === undefined) {
      throw new Error("Operation 'insert_at_line' requires 'content'");
    }
    lineNumber = _toInt(lineNumber, 'lineNumber');
    if (lineNumber < 1) {
      throw new Error("'lineNumber' must be >= 1");
    }
  } else if (operation === 'delete_lines') {
    startLine = _toInt(startLine, 'startLine');
    endLine = _toInt(endLine, 'endLine');
    if (startLine < 1 || endLine < 1) {
      throw new Error("'startLine' and 'endLine' must be >= 1");
    }
    if (endLine < startLine) {
      throw new Error("'endLine' must be >= 'startLine'");
    }
  }

  return {
    action,
    file_path: filePath,
    filename,
    operation,
    encoding,
    create_if_missing: createIfMissing,
    backup,
    content,
    search,
    replacement,
    line_number: lineNumber,
    start_line: startLine,
    end_line: endLine,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Change operations
// ---------------------------------------------------------------------------

function _applyOperation(original: string, data: Record<string, any>): string {
  const op = data.operation;

  if (op === 'replace_all') {
    return data.content;
  }

  if (op === 'append') {
    if (original && !original.endsWith('\n') && !original.endsWith('\r')) {
      return original + '\n' + data.content;
    }
    return original + data.content;
  }

  if (op === 'prepend') {
    return data.content + original;
  }

  if (op === 'replace_text') {
    return original.split(data.search).join(data.replacement);
  }

  if (op === 'insert_at_line') {
    const lines = _splitLinesKeepEnds(original);
    let idx = data.line_number - 1;
    idx = Math.max(0, Math.min(idx, lines.length));
    let insertion = data.content;
    if (insertion && !insertion.endsWith('\n') && !insertion.endsWith('\r')) {
      insertion += '\n';
    }
    lines.splice(idx, 0, insertion);
    return lines.join('');
  }

  if (op === 'delete_lines') {
    const lines = _splitLinesKeepEnds(original);
    let start = data.start_line - 1;
    let end = data.end_line;
    start = Math.max(0, start);
    end = Math.min(lines.length, end);
    if (start >= lines.length) {
      return original;
    }
    lines.splice(start, end - start);
    return lines.join('');
  }

  throw new Error(`Unhandled operation: ${op}`);
}

function _isInGitRepo(dir: string, filePath: string): boolean {
  let isInGitRepo = false;
  let gitInstalled = false;
  try {
    execSync('git --version', { stdio: 'pipe' });
    gitInstalled = true;
  } catch {
    gitInstalled = false;
  }

  if (gitInstalled) {
    try {
      const top = execSync('git rev-parse --show-toplevel', { cwd: dir, stdio: 'pipe' });
      if (top) {
        try {
          execSync(`git ls-files --error-unmatch "${filePath}"`, { cwd: dir, stdio: 'pipe' });
          isInGitRepo = true;
        } catch {
          isInGitRepo = false;
        }
      }
    } catch {
      isInGitRepo = false;
    }
  }

  return isInGitRepo;
}

function _wrapResponse(contentJson: string, sequential: any = null, nextPrompt: any = null): ExecutionResponse {
  return new ExecutionResponse(contentJson, nextPrompt, sequential, true);
}

// ---------------------------------------------------------------------------
// Core change-file operation
// ---------------------------------------------------------------------------

function changeFileFromPayload(payload: string | Record<string, any>, runtime?: Runtime): ExecutionResponse {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return _wrapResponse(`Invalid payload: ${e.message}`, true, '');
  }

  const sequential = data.sequential;
  const prompt = data.prompt;
  const baseDir = runtime?.workingDir?.path || process.cwd();
  const targetDir = data.file_path;

  let fullDir: string;
  if (path.isAbsolute(targetDir)) {
    fullDir = targetDir;
  } else {
    fullDir = path.resolve(baseDir, targetDir);
  }

  const fullPath = path.resolve(fullDir, data.filename);

  const blocked = _isBlockedPath(fullPath);
  if (blocked) {
    return _wrapResponse(`Blocked path (contains '${blocked}'); refusing to modify.`, sequential, prompt);
  }

  const fileExists = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile();
  let original = '';

  if (!fileExists) {
    if (!data.create_if_missing) {
      return _wrapResponse(`File does not exist: ${fullPath}. Set 'createIfMissing': 'true' to create it.`, sequential, prompt);
    }
    try {
      fs.mkdirSync(fullDir, { recursive: true });
    } catch (e: any) {
      return _wrapResponse(`Failed to create directory '${fullDir}': ${e.message}`, sequential, prompt);
    }
    original = '';
  } else {
    try {
      original = fs.readFileSync(fullPath, 'utf8');
    } catch (e: any) {
      return _wrapResponse(`Failed to read file: ${e.message}`, sequential, prompt);
    }
  }

  // Optional backup.
  if (data.backup && fileExists && !_isInGitRepo(fullDir, fullPath)) {
    const backupPath = fullPath + '.bak';
    try {
      fs.copyFileSync(fullPath, backupPath);
      console.log(`backup created at ${backupPath}`);
    } catch (e: any) {
      return _wrapResponse(`Failed to create backup: ${e.message}`, sequential, prompt);
    }
  }

  let newContent: string;
  try {
    newContent = _applyOperation(original, data);
  } catch (e: any) {
    return _wrapResponse(`Failed to apply operation: ${e.message}`, sequential, prompt);
  }

  // If nothing changed, short-circuit.
  if (newContent === original && fileExists) {
    return _wrapResponse(`No changes applied to ${fullPath} (content identical).`, sequential, prompt);
  }

  try {
    console.log(`file will be updated at ${fullPath} (operation=${data.operation})`);
    fs.writeFileSync(fullPath, newContent, { encoding: data.encoding });
  } catch (e: any) {
    return _wrapResponse(`Failed to write file: ${e.message}`, sequential, prompt);
  }

  return _wrapResponse(`Successfully changed file: ${fullPath} (operation=${data.operation})`, sequential, prompt);
}

// ---------------------------------------------------------------------------
// Remote (SSH) change-file operation
// ---------------------------------------------------------------------------

async function changeFileFromPayloadRemote(
  payload: string | Record<string, any>,
  runtime?: Runtime
): Promise<ExecutionResponse> {
  const baseDir = runtime?.workingDir;
  const serverName = baseDir?.kind === 'remote' ? baseDir.serverName : '';
  const remoteBaseDir = baseDir?.path;
  const server = baseDir?.kind === 'remote' ? baseDir.server : {};
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return _wrapResponse(`Invalid payload: ${e.message}`, false, '');
  }

  const sequential = data.sequential;
  const prompt = data.prompt;

  if (!serverName) {
    return _wrapResponse('Missing remote server name for SSH execution.', sequential, prompt);
  }

  const serverCfg = server;
  if (!serverCfg) {
    return _wrapResponse(`No SSH configuration found for server '${serverName}'.`, sequential, prompt);
  }

  // Resolve the target remote path (the remote host uses POSIX paths).
  const targetDir = data.file_path;
  let fullDir: string;
  if (path.posix.isAbsolute(targetDir)) {
    fullDir = targetDir;
  } else {
    fullDir = path.posix.resolve(remoteBaseDir || '.', targetDir);
  }
  const fullPath = path.posix.resolve(fullDir, data.filename);

  const blocked = _isBlockedPath(fullPath);
  if (blocked) {
    return _wrapResponse(`Blocked path (contains '${blocked}'); refusing to modify.`, sequential, prompt);
  }

  const connectConfig = buildConnectConfig(serverName, serverCfg);

  let conn: Client | null = null;
  try {
    conn = await connect(connectConfig);
    const sftp = await getSftp(conn);

    const fileExists = await remoteFileExists(sftp, fullPath);
    let original = '';

    if (!fileExists) {
      if (!data.create_if_missing) {
        return _wrapResponse(`File does not exist: ${fullPath}. Set 'createIfMissing': 'true' to create it.`, sequential, prompt);
      }
      await sftpMkdir(sftp, fullDir);
      original = '';
    } else {
      try {
        original = await sftpReadFile(sftp, fullPath);
      } catch (e: any) {
        return _wrapResponse(`Failed to read file: ${e.message}`, sequential, prompt);
      }
    }

    // Optional backup (skip when the file is tracked in a remote git repo).
    if (data.backup && fileExists) {
      const inGit = await remoteIsInGitRepo(conn, fullDir, fullPath);
      if (!inGit) {
        try {
          const backupContent = await sftpReadFile(sftp, fullPath);
          await sftpWriteFile(sftp, fullPath + '.bak', backupContent);
        } catch (e: any) {
          return _wrapResponse(`Failed to create backup: ${e.message}`, sequential, prompt);
        }
      }
    }

    let newContent: string;
    try {
      newContent = _applyOperation(original, data);
    } catch (e: any) {
      return _wrapResponse(`Failed to apply operation: ${e.message}`, sequential, prompt);
    }

    // If nothing changed, short-circuit.
    if (newContent === original && fileExists) {
      return _wrapResponse(`No changes applied to ${fullPath} (content identical).`, sequential, prompt);
    }

    try {
      await sftpWriteFile(sftp, fullPath, newContent);
    } catch (e: any) {
      return _wrapResponse(`Failed to write file: ${e.message}`, sequential, prompt);
    }

    return _wrapResponse(`Successfully changed file: ${fullPath} (operation=${data.operation})`, sequential, prompt);
  } catch (e: any) {
    return _wrapResponse(`Failed to change remote file over SSH: ${e.message}`, sequential, prompt);
  } finally {
    if (conn) {
      try { conn.end(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFileChangerExecute(jsonPayload: string, runtime?: Runtime): ExecutionResponse {
  return changeFileFromPayload(jsonPayload, runtime);
}

function skillFileChangerExecuteRemote(
  jsonPayload: string,
  runtime?: Runtime
): Promise<ExecutionResponse> {
  return changeFileFromPayloadRemote(jsonPayload, runtime);
}

export function execute(jsonPayload: string, runtime: Runtime): ExecutionResponse | Promise<ExecutionResponse> {
  // Navigate the Runtime structure: the resolved working directory lives at
  // runtime.workingDir (kind, serverName, path, server).
  const workingDir = runtime?.workingDir;
  if (workingDir && workingDir.kind === 'remote') {
    return skillFileChangerExecuteRemote(jsonPayload, runtime);
  }
  return skillFileChangerExecute(jsonPayload, runtime);
}

export const ACTION_NAME = "change_file";
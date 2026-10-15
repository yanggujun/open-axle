import * as fs from 'fs';
import * as path from 'path';
import { Runtime, ExecutionResponse, extractJson, getSequential, buildConnectConfig, connect, getSftp, sftpStat, sftpMkdir } from '../../common/common';

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

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'create_folder';
  if (action !== 'create_folder') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  let folderPath = (props.folderPath ?? '').toString();
  let folderName = (props.folderName ?? '').toString();

  if (!folderPath && !folderName) {
    throw new Error("Must provide 'folderPath' and/or 'folderName'");
  }

  if (!folderPath) {
    folderPath = './';
  }

  // If folder_path already looks like it includes a folder name, split it.
  const base = path.basename(folderPath);
  if (base && !folderName) {
    folderName = base;
    folderPath = path.dirname(folderPath) || './';
  }

  if (!folderName) {
    throw new Error("Missing required field: 'folderName'");
  }

  if (/[\n\r\0]/.test(folderName)) {
    throw new Error('Invalid characters in folderName');
  }

  const recursive = ((props.recursive ?? 'true').toString().toLowerCase()) === 'true';
  const encoding = props.encoding ?? 'utf-8';
  const description = props.description ?? '';

  const [sequential, nextPrompt] = getSequential(payload);

  return {
    action,
    folder_path: folderPath,
    folder_name: folderName,
    recursive,
    encoding,
    description,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core create-folder operation
// ---------------------------------------------------------------------------

function createFolderFromPayload(payload: string | Record<string, any>, runtime?: Runtime): ExecutionResponse | string {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  const baseDir = runtime?.workingDir?.path || process.cwd();
  const targetDir = data.folder_path;

  // Resolve target path.
  let fullDir: string;
  if (path.isAbsolute(targetDir)) {
    fullDir = targetDir;
  } else {
    fullDir = path.resolve(baseDir, targetDir);
  }

  const fullPath = path.resolve(fullDir, data.folder_name);

  const blocked = _isBlockedPath(fullPath);
  if (blocked) {
    return `Blocked path (contains '${blocked}'); refusing to create folder.`;
  }

  // Overwrite guard: if folder exists, return message (never overwrite).
  if (fs.existsSync(fullPath)) {
    return new ExecutionResponse(
      `Folder already exists at ${fullPath}`,
      data.prompt,
      data.sequential,
      true
    );
  }

  try {
    if (data.recursive) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      const parent = path.dirname(fullPath);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        return `Parent directory '${parent}' does not exist. Set recursive=true to create intermediate directories.`;
      }
      fs.mkdirSync(fullPath);
    }

    return new ExecutionResponse(
      `Folder created at ${fullPath}`,
      data.prompt,
      data.sequential,
      true
    );
  } catch (e: any) {
    return `Failed to create folder: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Remote (SSH) create-folder operation
// ---------------------------------------------------------------------------

async function createFolderFromPayloadRemote(
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

  // Resolve the target remote folder path (the remote host uses POSIX paths).
  const targetDir = data.folder_path;
  const fullDir = path.posix.isAbsolute(targetDir)
    ? targetDir
    : path.posix.resolve(remoteBaseDir || '.', targetDir);
  const fullPath = path.posix.resolve(fullDir, data.folder_name);

  const blocked = _isBlockedPath(fullPath);
  if (blocked) {
    return `Blocked path (contains '${blocked}'); refusing to create folder.`;
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

    // Overwrite guard: if the folder already exists, never overwrite it.
    let exists = false;
    try {
      await sftpStat(sftp, fullPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      return new ExecutionResponse(
        `Folder already exists at ${fullPath}`,
        data.prompt,
        data.sequential,
        true
      );
    }

    // For non-recursive creation, ensure the parent directory exists first.
    if (!data.recursive) {
      const parent = path.posix.dirname(fullPath);
      let parentExists = false;
      try {
        const pst = await sftpStat(sftp, parent);
        parentExists = pst.isDirectory();
      } catch {
        parentExists = false;
      }
      if (!parentExists) {
        return `Parent directory '${parent}' does not exist. Set recursive=true to create intermediate directories.`;
      }
    }

    // sftpMkdir creates intermediate directories (recursive).
    await sftpMkdir(sftp, fullPath);

    return new ExecutionResponse(
      `Folder created at ${fullPath}`,
      data.prompt,
      data.sequential,
      true
    );
  } catch (e: any) {
    return `Failed to create remote folder over SSH: ${e.message}`;
  } finally {
    if (conn) {
      try { conn.end(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFolderCreatorExecute(jsonPayload: string, runtime?: Runtime): ExecutionResponse | string {
  return createFolderFromPayload(jsonPayload, runtime);
}

/**
 * New entry point: create a folder on a remote host over SSH. Mirrors
 * skillFolderCreatorExecute but targets the configured remote server.
 */
function skillFolderCreatorExecuteRemote(
  jsonPayload: string,
  runtime?: Runtime
): Promise<ExecutionResponse | string> {
  return createFolderFromPayloadRemote(jsonPayload, runtime);
}

export function execute(jsonPayload: string, runtime: Runtime): ExecutionResponse | string | Promise<ExecutionResponse | string> {
  // Navigate the Runtime structure: the resolved working directory lives at
  // runtime.workingDir (kind, serverName, path, server).
  const workingDir = runtime?.workingDir;
  if (workingDir && workingDir.kind === 'remote') {
    return skillFolderCreatorExecuteRemote(jsonPayload, runtime);
  }
  return skillFolderCreatorExecute(jsonPayload, runtime);
}

export const ACTION_NAME = "create_folder";
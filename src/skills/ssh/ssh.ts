import * as fs from 'fs';
import * as path from 'path';
import { Client, ConnectConfig } from 'ssh2';
import { ExecutionResponse, extractJson, getSequential, getSkillConfig } from '../../core/executor';

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const BLOCKED_PATH_FRAGMENTS = [
  '/etc/shadow',
  '/etc/passwd',
  '/root/',
  '~/.ssh',
  '.ssh/id_rsa',
  '/home/admin/.ssh',
  'c:\\windows',
  'c:\\program files',
];

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+\/\*/,
  /rm\s+-rf\s+~$/,
  /dd\s+if=/,
  /format\s+[a-zA-Z]:/,
  /\/:\{\s*\|\s*:\|&\s*\};\s*:/,
  /mkfs\./,
  /fdisk\s+\/[a-zA-Z]/,
  /parted\s+\/[a-zA-Z]/,
  /shutdown\s+-[hr]/,
  /reboot\s*/,
  /halt\s*/,
  /poweroff\s*/,
  />\s*\/dev\/sda/,
  /\|\s*sh$/,
  /curl\s+.*\|\s*sh/,
  /wget\s+.*\|\s*sh/,
];

const DESTRUCTIVE_PATTERNS = [
  'rm -rf /',
  'dd if=',
  'format',
  'mkfs.',
  'fdisk',
  'parted',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  '> /dev/sda',
];

const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB max

function _isBlockedPath(p: string): string | null {
  const low = p.toLocaleLowerCase();
  for (const frag of BLOCKED_PATH_FRAGMENTS) {
    if (low.includes(frag.toLocaleLowerCase())) {
      return frag;
    }
  }
  return null;
}

function _isDangerousCommand(cmd: string): string | null {
  const lower = cmd.toLocaleLowerCase();
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(lower)) {
      return pattern.source;
    }
  }
  return null;
}

function _isDestructive(cmd: string): boolean {
  const lower = cmd.toLocaleLowerCase();
  return DESTRUCTIVE_PATTERNS.some((dp) => lower.includes(dp));
}

// ---------------------------------------------------------------------------
// Payload validation & normalization
// ---------------------------------------------------------------------------

function _toInt(value: any, def: number): number {
  if (value === null || value === undefined || value === '') return def;
  const n = parseInt(String(value).trim(), 10);
  return isNaN(n) ? def : n;
}

function _toBool(value: any, def: boolean): boolean {
  if (value === null || value === undefined || value === '') return def;
  const v = String(value).trim().toLocaleLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'ssh';
  const [sequential, nextPromptRaw] = getSequential(payload);

  if (action !== 'ssh') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  const host = (props.host ?? '').toString().trim();
  const operation = (props.operation ?? 'exec').toString().trim().toLocaleLowerCase();
  const command = (props.command ?? '').toString().trim();
  const localPath = (props.localPath ?? '').toString().trim();
  const remotePath = (props.remotePath ?? '').toString().trim();
  let timeout = _toInt(props.timeout, 30);
  const allowDestructive = _toBool(props.allowDestructive, false);
  const maxOutput = _toInt(props.maxOutput, MAX_OUTPUT_SIZE);
  const description = (props.description ?? '').toString();

  if (!host) {
    throw new Error("Missing required field: 'host'");
  }

  if (operation !== 'exec' && operation !== 'upload' && operation !== 'download') {
    throw new Error(`Unsupported operation: ${operation}. Valid values: exec, upload, download.`);
  }

  if (operation === 'exec' && !command) {
    throw new Error("Missing required field: 'command' for exec operation");
  }

  if ((operation === 'upload' || operation === 'download') && (!localPath || !remotePath)) {
    throw new Error("For upload/download, 'localPath' and 'remotePath' are required.");
  }

  if (timeout < 1) timeout = 1;
  if (timeout > 120) timeout = 120;

  // Safety: check for blocked paths in command or file paths.
  const checkStrings = operation === 'exec' ? [command] : [remotePath, localPath, host];
  for (const s of checkStrings) {
    const blocked = _isBlockedPath(s);
    if (blocked) {
      throw new Error(`Blocked path (contains '${blocked}'); refusing to operate.`);
    }
  }

  // Safety: check for dangerous commands.
  if (operation === 'exec') {
    const dangerous = _isDangerousCommand(command);
    if (dangerous) {
      throw new Error(`Blocked dangerous command pattern: ${dangerous}`);
    }
    if (_isDestructive(command) && !allowDestructive) {
      throw new Error('Destructive command blocked. Set allowDestructive=true to permit.');
    }
  }

  let nextPrompt = nextPromptRaw;
  if (sequential && nextPrompt) {
    nextPrompt = nextPrompt + '\n' + 'Following is the SSH operation output: \n';
  }

  return {
    action,
    host,
    operation,
    command,
    localPath,
    remotePath,
    timeout,
    allowDestructive,
    maxOutput: Math.min(maxOutput, MAX_OUTPUT_SIZE),
    description,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core SSH operation
// ---------------------------------------------------------------------------

function _buildConnectConfig(config: Record<string, string>, timeoutMs: number): ConnectConfig {
  const options: ConnectConfig = {
    host: config.host,
    port: parseInt(config.port, 10) || 22,
    username: config.user_name,
    readyTimeout: timeoutMs,
    keepaliveInterval: 10000,
    keepaliveCountMax: 3,
  };

  if (config.auth_type === 'key' && config.key_file) {
    options.privateKey = fs.readFileSync(config.key_file);
    if (config.passphrase) {
      options.passphrase = config.passphrase;
    }
  } else {
    options.password = config.pass;
  }

  // Host key policy: the previous CLI implementation used
  // `-o StrictHostKeyChecking=no` (accept any key). We keep that as the default
  // but allow opt-in verification by configuring a known_hosts file. When
  // present, the presented host key must match an entry in that file.
  if (config.known_hosts) {
    const verifier = _buildKnownHostsVerifier(config.known_hosts);
    options.hostVerifier = verifier ?? (() => true);
  } else {
    options.hostVerifier = () => true;
  }

  return options;
}

function _buildKnownHostsVerifier(knownHostsPath: string): ((key: Buffer) => boolean) | null {
  let lines: string[];
  try {
    lines = fs.readFileSync(knownHostsPath, 'utf-8').split('\n');
  } catch {
    return null;
  }
  const entries = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (entries.length === 0) {
    return null;
  }
  return (key: Buffer): boolean => {
    const presented = key.toString('base64');
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      if (parts.length < 3) continue;
      if (parts[0].startsWith('|1|')) continue; // skip hashed host entries
      if (parts[2] === presented) {
        return true;
      }
    }
    return false;
  };
}

function _connect(config: Record<string, string>, timeoutMs: number): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve(conn);
    });
    conn.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    try {
      conn.connect(_buildConnectConfig(config, timeoutMs));
    } catch (e: any) {
      if (settled) return;
      settled = true;
      reject(e);
    }
  });
}

function _execCommand(
  conn: Client,
  command: string,
  timeoutMs: number,
  maxOutput: number
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`SSH command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 0 });
      });
      stream.on('data', (chunk: Buffer) => {
        if (stdout.length < maxOutput) {
          stdout += chunk.toString('utf-8');
        }
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < maxOutput) {
          stderr += chunk.toString('utf-8');
        }
      });
    });
  });
}

function _sftpTransfer(
  conn: Client,
  localPath: string,
  remotePath: string,
  isUpload: boolean
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) {
        reject(err);
        return;
      }

      if (isUpload) {
        if (!fs.existsSync(localPath)) {
          reject(new Error(`Local file not found for upload: ${localPath}`));
          return;
        }
        sftp.fastPut(localPath, remotePath, {}, (putErr) => {
          if (putErr) {
            reject(putErr);
          } else {
            resolve(`Uploaded ${localPath} -> ${remotePath}`);
          }
        });
      } else {
        sftp.fastGet(remotePath, localPath, {}, (getErr) => {
          if (getErr) {
            reject(getErr);
          } else {
            resolve(`Downloaded ${remotePath} -> ${localPath}`);
          }
        });
      }
    });
  });
}

function _finalize(out: string, data: Record<string, any>): ExecutionResponse {
  const seq = data.sequential;
  return new ExecutionResponse(out, data.prompt, seq, !seq, 'json');
}

async function runSshFromPayload(payload: string | Record<string, any>, baseDir?: string): Promise<ExecutionResponse | string> {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  baseDir = baseDir || process.cwd();

  let config: Record<string, string>;
  try {
    config = getSkillConfig('ssh', data.host);
  } catch (e: any) {
    return `Configuration error: ${e.message}`;
  }

  const timeoutMs = data.timeout * 1000;
  const maxOutput = data.maxOutput;

  let conn: Client | undefined;
  try {
    conn = await _connect(config, timeoutMs);

    if (data.operation === 'exec') {
      const { stdout, stderr, code } = await _execCommand(conn, data.command, timeoutMs, maxOutput);
      let out = `return code: ${code}\n`;
      if (stdout) {
        out += stdout + '\n';
      }
      if (stderr) {
        out += 'stderr\n';
        out += stderr;
      }
      return _finalize(out, data);
    }

    // upload / download over SFTP
    const isUpload = data.operation === 'upload';
    const message = await _sftpTransfer(conn, data.localPath, data.remotePath, isUpload);
    return _finalize(message, data);
  } catch (e: any) {
    return _finalize(`Failed to execute SSH operation: ${e.message}`, data);
  } finally {
    if (conn) {
      try {
        conn.end();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillSshExecute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return runSshFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return skillSshExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "ssh";

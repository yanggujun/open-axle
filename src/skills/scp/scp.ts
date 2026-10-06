import * as fs from 'fs';
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
  const action = payload.action ?? 'scp';
  const [sequential, nextPromptRaw] = getSequential(payload);

  if (action !== 'scp') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  const operation = (props.operation ?? '').toString().trim().toLocaleLowerCase();
  const host = (props.host ?? '').toString().trim();
  const localPath = (props.localPath ?? '').toString().trim();
  const remotePath = (props.remotePath ?? '').toString().trim();
  let timeout = _toInt(props.timeout, 30);
  const maxOutput = _toInt(props.maxOutput, MAX_OUTPUT_SIZE);
  const overwrite = _toBool(props.overwrite, false);
  const description = (props.description ?? '').toString();

  if (operation !== 'upload' && operation !== 'download') {
    throw new Error(`Unsupported operation: ${operation}. Valid values: upload, download.`);
  }

  if (!host) {
    throw new Error("Missing required field: 'host'");
  }

  if (!localPath || !remotePath) {
    throw new Error("Missing required field: 'localPath' and 'remotePath' are required.");
  }

  if (timeout < 1) timeout = 1;
  if (timeout > 120) timeout = 120;

  // Safety: check for blocked paths.
  const blocked = _isBlockedPath(remotePath) || _isBlockedPath(localPath) || _isBlockedPath(host);
  if (blocked) {
    throw new Error(`Blocked path (contains '${blocked}'); refusing to operate.`);
  }

  // For download, check overwrite if local file exists.
  if (operation === 'download' && !overwrite && fs.existsSync(localPath)) {
    const stats = fs.statSync(localPath);
    if (stats.isFile()) {
      throw new Error(`Local file already exists: ${localPath}. Set overwrite=true to replace.`);
    }
  }

  // For upload, verify the local file exists before attempting transfer.
  if (operation === 'upload' && !fs.existsSync(localPath)) {
    throw new Error(`Local file not found for upload: ${localPath}`);
  }

  let nextPrompt = nextPromptRaw;
  if (sequential && nextPrompt) {
    nextPrompt = nextPrompt + '\n\n' + 'Following is the SCP operation output: \n\n';
  }

  return {
    action,
    operation,
    host,
    localPath,
    remotePath,
    timeout,
    maxOutput: Math.min(maxOutput, MAX_OUTPUT_SIZE),
    overwrite,
    description,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core SCP operation (implemented over ssh2 SFTP; no shell-out)
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

function getRemoteHome(conn: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec('echo $HOME', (err, stream) => {
      if (err) return reject(err);

      let out = '';
      let errOut = '';

      stream
        .on('close', (code: number) => {
          const home = out.trim();
          if (code === 0 && home) {
            resolve(home);
          } else {
            reject(new Error(`Failed to resolve $HOME (exit ${code}): ${errOut.trim()}`));
          }
        })
        .on('data', (d: Buffer) => { out += d.toString(); })
        .stderr.on('data', (d: Buffer) => { errOut += d.toString(); });
    });
  });
}

function _sftpTransfer(
  conn: Client,
  localPath: string,
  remotePath: string,
  isUpload: boolean,
  timeoutMs: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`SCP transfer timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const finish = (err: Error | null, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        reject(err);
      } else {
        resolve(message ?? '');
      }
    };

    conn.sftp((err, sftp) => {
      if (err) {
        finish(err);
        return;
      }

      if (isUpload) {
        if (!fs.existsSync(localPath)) {
          finish(new Error(`Local file not found for upload: ${localPath}`));
          return;
        }
        sftp.fastPut(localPath, remotePath, {}, (putErr) => {
          if (putErr) {
            finish(putErr);
          } else {
            finish(null, `Uploaded ${localPath} -> ${remotePath}`);
          }
        });
      } else {
        sftp.fastGet(remotePath, localPath, {}, (getErr) => {
          if (getErr) {
            finish(getErr);
          } else {
            finish(null, `Downloaded ${remotePath} -> ${localPath}`);
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

async function runScpFromPayload(payload: string | Record<string, any>, baseDir?: string): Promise<ExecutionResponse | string> {
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
    config = getSkillConfig('scp', data.host);
  } catch (e: any) {
    return `Configuration error: ${e.message}`;
  }

  const timeoutMs = data.timeout * 1000;
  const maxOutput = data.maxOutput;

  let conn: Client | undefined;
  try {
    conn = await _connect(config, timeoutMs);

    const isUpload = data.operation === 'upload';
    let remotePath = data.remotePath;
    if (remotePath === '~' || remotePath.startsWith('~/')) {
      const home = await getRemoteHome(conn);
      const rest = remotePath === '~' ? '' : remotePath.slice(1); // keep the leading '/' from '~/...'
      remotePath = (home + rest).replace(/\/{2,}/g, '/');
    }
    const message = await _sftpTransfer(conn, data.localPath, remotePath, isUpload, timeoutMs);

    const capped = message.substring(0, maxOutput);
    return _finalize(capped, data);
  } catch (e: any) {
    return _finalize(`Failed to execute SCP operation: ${e.message}`, data);
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

function skillScpExecute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return runScpFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return skillScpExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "scp";

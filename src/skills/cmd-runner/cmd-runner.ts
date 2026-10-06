import * as fs from 'fs';
import * as path from 'path';
import { exec, ExecOptions } from 'child_process';
import { ExecutionResponse, extractJson, getSequential } from '../../core/executor';

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

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+\/\*/,
  /rm\s+-rf\s+~$/,
  /dd\s+if=/,
  /format\s+[a-zA-Z]:/,
  /\/:\{\s*\|\s*:\|&\s*\};\s*:/, // fork bomb
  /mkfs\./,
  /fdisk\s+\/[a-zA-Z]/,
  /parted\s+\/[a-zA-Z]/,
  /shutdown\s+-[hr]/,
  /reboot\s/,
  /halt\s/,
  /poweroff\s/,
  /del\s+\/f\s+\/s\s+\/q/,
  /rd\s+\/s\s+\/q\s+c:\\/,
  />\s*\/dev\/sda/,
  /\|\s*sh$/,
  /curl\s+.*\|\s*sh/,
  /wget\s+.*\|\s*sh/,
];

const SHELL_EXECUTABLES: Record<string, string> = {
  bash: '/bin/bash',
  maccmd: '/bin/zsh',
  windowsbat: 'cmd.exe',
  windowsps: 'powershell.exe',
};

function _isBlockedPath(p: string): string | null {
  const low = p.replace(/\\/g, '\\').toLowerCase();
  for (const frag of BLOCKED_PATH_FRAGMENTS) {
    if (low.includes(frag.toLowerCase())) {
      return frag;
    }
  }
  return null;
}

function _isDangerousCommand(cmd: string): string | null {
  const lower = cmd.toLowerCase();
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(lower)) {
      return pattern.source;
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
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return def;
}

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'run_command';
  const [sequential, nextPromptRaw] = getSequential(payload);

  if (action !== 'run_command') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  const command = (props.command ?? '').toString().trim();
  const cwd = (props.cwd ?? './').toString() || './';
  let timeout = _toInt(props.timeout, 30);
  const shell = _toBool(props.shell, true);
  const shelltype = (props.shelltype ?? '').toString().toLowerCase() || 'bash';
  const envRaw = (props.env ?? '{}').toString() || '{}';
  const description = (props.description ?? '').toString();

  if (!command) {
    throw new Error("Missing required field: 'command'");
  }

  if (!SHELL_EXECUTABLES[shelltype]) {
    throw new Error(`Unsupported shelltype: ${shelltype}. Valid values: ${Object.keys(SHELL_EXECUTABLES).join(', ')}`);
  }

  // Enforce timeout limits (default 30s, max 120s).
  if (timeout < 1) timeout = 1;
  if (timeout > 120) timeout = 120;

  // Parse env JSON if provided.
  let env: Record<string, string> = {};
  if (envRaw && envRaw !== '{}') {
    try {
      const parsed = JSON.parse(envRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        env = parsed;
      } else {
        throw new Error('env must be a JSON object');
      }
    } catch (e: any) {
      throw new Error(`Invalid env JSON: ${e.message}`);
    }
  }

  // Safety: check for dangerous commands.
  const dangerous = _isDangerousCommand(command);
  if (dangerous) {
    throw new Error(`Blocked dangerous command pattern: ${dangerous}`);
  }

  // Safety: check for sensitive paths in command.
  const blocked = _isBlockedPath(command);
  if (blocked) {
    throw new Error(`Blocked path (contains '${blocked}'); refusing to execute.`);
  }

  let nextPrompt = nextPromptRaw;
  if (sequential && nextPrompt) {
    nextPrompt = nextPrompt + '\n\n' + 'Following is the command execution output: \n\n';
  }

  return {
    action,
    command,
    cwd,
    timeout,
    shell,
    shelltype,
    shellExecutable: SHELL_EXECUTABLES[shelltype],
    env,
    description,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core command execution operation
// ---------------------------------------------------------------------------

const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB max

async function runCommandFromPayload(payload: string | Record<string, any>, baseDir?: string): Promise<ExecutionResponse | string> {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  baseDir = baseDir || process.cwd();

  // Resolve working directory.
  let fullCwd: string;
  if (path.isAbsolute(data.cwd)) {
    fullCwd = data.cwd;
  } else {
    fullCwd = path.resolve(baseDir, data.cwd);
  }

  // Safety check on cwd.
  const blockedCwd = _isBlockedPath(fullCwd);
  if (blockedCwd) {
    return `Blocked path (contains '${blockedCwd}'); refusing to execute.`;
  }

  // Check that cwd exists.
  if (!fs.existsSync(fullCwd)) {
    return `Directory not found: ${fullCwd}`;
  }
  if (!fs.statSync(fullCwd).isDirectory()) {
    return `Path is not a directory: ${fullCwd}`;
  }

  return new Promise<ExecutionResponse>((resolve) => {
    // Build the command line based on shelltype.
    let cmd: string;
    if (data.shell) {
      // Use shell wrapper when shell=true.
      cmd = data.command;
    } else {
      // When shell=false, just run the command directly.
      cmd = data.command;
    }

    const options: ExecOptions = {
      cwd: fullCwd,
      timeout: data.timeout * 1000, // ms
      maxBuffer: MAX_OUTPUT_SIZE,
      env: { ...process.env, ...data.env } as Record<string, string>,
      shell: data.shellExecutable as any,
    };

    exec(cmd, options, (error, stdout, stderr) => {
      const returncode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;

      // Cap output sizes.
      const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString();
      const stderrStr = typeof stderr === 'string' ? stderr : stderr.toString();
      const cappedStdout = stdoutStr.substring(0, MAX_OUTPUT_SIZE);
      const cappedStderr = stderrStr.substring(0, MAX_OUTPUT_SIZE);

      let out = `return code: ${returncode}\n\n`;
      if (cappedStdout) {
        out += cappedStdout + '\n';
      }
      if (cappedStderr) {
        out += 'stderr\n';
        out += cappedStderr;
      }

      const seq = data.sequential;
      const response = new ExecutionResponse(out, data.prompt, seq, !seq, 'json');
      resolve(response);
    });
  }).catch((e: any) => {
    return `Failed to execute command: ${e.message}`;
  });
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillCmdRunnerExecute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return runCommandFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): Promise<ExecutionResponse | string> {
  return skillCmdRunnerExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "run_command";

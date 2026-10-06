import * as fs from 'fs';
import * as path from 'path';
import { ExecutionResponse, extractJson, getSequential, readFile } from '../../core/executor';

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

function readFileFromPayload(payload: string | Record<string, any>, baseDir?: string): ExecutionResponse | string {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  baseDir = baseDir || process.cwd();
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
      data.prompt,
      true,
      false
    );
  }
  if (!fs.statSync(fullPath).isFile()) {
    return `Path is not a regular file: ${fullPath}`;
  }

  // Read the file.
  let content: string;
  try {
    content = readFile(fullPath, data.start_line, data.end_line, data.max_bytes);
  } catch (e: any) {
    return `Failed to read file: ${e.message}`;
  }

  const ext = path.extname(fullPath).replace(/^\./, '');

  const seq = data.sequential;
  let nextPrompt = data.prompt;
  if (seq && data.prompt) {
    nextPrompt = `${data.prompt}\n\nFollowing is the content of file ${fullPath}:\n\n`;
  }
  return new ExecutionResponse(content, nextPrompt, seq, !seq, ext);
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFileReaderExecute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return readFileFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return skillFileReaderExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "read_file";
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionResponse, extractJson, getSequential } from '../../core/executor';

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
  const action = payload.action ?? 'create_file';
  if (action !== 'create_file') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  let filePath = (props.filePath ?? '').toString();
  let filename = (props.fileName ?? '').toString();
  const content = props.content ?? '';
  const encoding = props.encoding ?? 'utf-8';
  const overwrite = props.overwrite?.toString().toLowerCase() === 'true';
  const [sequential, nextPrompt] = getSequential(payload);

  if (!filePath && !filename) {
    throw new Error("Must provide 'file_path' and/or 'filename'");
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
    throw new Error("Missing required field: 'filename'");
  }

  if (/[\n\r\0]/.test(filename)) {
    throw new Error('Invalid characters in filename');
  }

  return {
    action,
    file_path: filePath,
    filename,
    encoding,
    overwrite,
    content,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core create-file operation
// ---------------------------------------------------------------------------

function createFileFromPayload(payload: string | Record<string, any>, baseDir?: string): ExecutionResponse | string {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  baseDir = baseDir || process.cwd();
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
    return `Blocked path (contains '${blocked}'); refusing to write.`;
  }

  if (fs.existsSync(fullPath) && !data.overwrite) {
    return "File already exists.";
  }

  try {
    fs.mkdirSync(fullDir, { recursive: true });
  } catch (e: any) {
    return `Failed to create directory ${fullDir}: ${e.message}`;
  }

  try {
    let content = data.content;
    if (typeof content !== 'string') {
      content = JSON.stringify(content, null, 2);
    }
    console.log(`file will be written to ${fullPath}`);
    fs.writeFileSync(fullPath, content, { encoding: data.encoding });
    const resp = `File ${fullPath} is created successfully.`;
    return new ExecutionResponse(resp, data.prompt, data.sequential, true);
  } catch (e: any) {
    return `Failed to write file: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFileCreatorExecute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return createFileFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return skillFileCreatorExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "create_file";
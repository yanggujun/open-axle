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
// Helper functions
// ---------------------------------------------------------------------------

function _toBool(value: any, def: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return ['true', '1', 'yes'].includes(value.toLowerCase());
  }
  if (typeof value === 'number') return Boolean(value);
  return def;
}

function _toInt(value: any, def: number): number {
  if (value === null || value === undefined || value === '') return def;
  const n = parseInt(String(value).trim(), 10);
  return isNaN(n) ? def : n;
}

// ---------------------------------------------------------------------------
// Payload validation & normalization
// ---------------------------------------------------------------------------

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'list_files';
  const [sequential, nextPrompt] = getSequential(payload);

  if (action !== 'list_files') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  const directoryPath = props.directoryPath ?? './';
  const recursive = _toBool(props.recursive, false);
  const includeHidden = _toBool(props.includeHidden, false);
  const includeGlob = (props.includeGlob ?? '*').toString() || '*';
  const excludeGlob = (props.excludeGlob ?? '').toString() || '';
  const showDetails = _toBool(props.showDetails, false);
  let maxResults = _toInt(props.maxResults, 500);
  if (maxResults < 1) maxResults = 500;

  if (/[\n\r\0]/.test(directoryPath.toString())) {
    throw new Error('Invalid characters in directoryPath');
  }

  return {
    action,
    directory_path: directoryPath,
    recursive,
    include_hidden: includeHidden,
    include_glob: includeGlob,
    exclude_glob: excludeGlob,
    show_details: showDetails,
    max_results: maxResults,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Core list-file operation
// ---------------------------------------------------------------------------

function _globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`);
}

function _matchesGlob(name: string, pattern: string): boolean {
  return _globToRegex(pattern).test(name);
}

function listFilesFromPayload(payload: string | Record<string, any>, baseDir?: string): ExecutionResponse | string {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  baseDir = baseDir || process.cwd();
  const targetDir = data.directory_path;

  let fullDir: string;
  if (path.isAbsolute(targetDir)) {
    fullDir = targetDir;
  } else {
    fullDir = path.resolve(baseDir, targetDir);
  }

  const blocked = _isBlockedPath(fullDir);
  if (blocked) {
    return `Blocked path (contains '${blocked}'); refusing to list.`;
  }

  if (!fs.existsSync(fullDir)) {
    return `Directory not found: ${fullDir}`;
  }
  if (!fs.statSync(fullDir).isDirectory()) {
    return `Path is not a directory: ${fullDir}`;
  }

  const includeGlob = data.include_glob;
  const excludeGlob = data.exclude_glob;
  const excludePatterns = excludeGlob
    ? excludeGlob.split(',').map((g: any) => g.toString().trim()).filter(Boolean)
    : [];
  const maxResults = data.max_results;
  const showDetails = data.show_details;

  const entries: Array<string | [string, number, number]> = [];
  let count = 0;

  if (data.recursive) {
    const stack: string[] = [fullDir];
    while (stack.length > 0 && count < maxResults) {
      const dir = stack.pop()!;
      const entriesInDir = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entriesInDir) {
        if (entry.isDirectory()) {
          if (data.include_hidden || !entry.name.startsWith('.')) {
            stack.push(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const fname = entry.name;
          if (!data.include_hidden && fname.startsWith('.')) continue;
          if (includeGlob !== '*' && !_matchesGlob(fname, includeGlob)) continue;
          if (excludePatterns.some((pat: any) => _matchesGlob(fname, pat))) continue;

          const fullPath = path.join(dir, fname);
          if (showDetails) {
            let size = 0, mtime = 0;
            try {
              const st = fs.statSync(fullPath);
              size = st.size;
              mtime = Math.floor(st.mtimeMs / 1000);
            } catch {
              size = 0; mtime = 0;
            }
            entries.push([fullPath, size, mtime]);
          } else {
            entries.push(fullPath);
          }
          count++;
          if (count >= maxResults) break;
        }
      }
    }
  } else {
    try {
      const entriesInDir = fs.readdirSync(fullDir, { withFileTypes: true });
      for (const entry of entriesInDir) {
        if (!entry.isFile()) continue;
        const fname = entry.name;
        if (!data.include_hidden && fname.startsWith('.')) continue;
        if (includeGlob !== '*' && !_matchesGlob(fname, includeGlob)) continue;
        if (excludePatterns.some((pat: any) => _matchesGlob(fname, pat))) continue;

        const fullPath = path.join(fullDir, fname);
        if (showDetails) {
          let size = 0, mtime = 0;
          try {
            const st = fs.statSync(fullPath);
            size = st.size;
            mtime = Math.floor(st.mtimeMs / 1000);
          } catch {
            size = 0; mtime = 0;
          }
          entries.push([fullPath, size, mtime]);
        } else {
          entries.push(fullPath);
        }
        count++;
        if (count >= maxResults) break;
      }
    } catch (e: any) {
      return `Permission denied to read directory: ${fullDir}`;
    }
  }

  // Format output.
  const lines: string[] = [];
  if (entries.length === 0) {
    lines.push('(empty directory)');
  } else {
    if (showDetails) {
      lines.push(`${'Name'.padEnd(40)} ${'Size'.padStart(10)} ${'Modified'.padStart(12)}`);
      lines.push('-'.repeat(65));
      for (const item of entries) {
        if (Array.isArray(item)) {
          const [name, size, mtime] = item;
          lines.push(`${name.padEnd(40)} ${String(size).padStart(10)} ${String(mtime).padStart(12)}`);
        }
      }
    } else {
      for (const item of entries) {
        lines.push(item.toString());
      }
    }
  }

  const content = lines.join('\n');
  return new ExecutionResponse(content, data.prompt, data.sequential, true);
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFileListExecute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return listFilesFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return skillFileListExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "list_files";
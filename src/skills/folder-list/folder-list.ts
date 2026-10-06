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
  const action = payload.action ?? 'list_folders';
  const [sequential, nextPrompt] = getSequential(payload);

  if (action !== 'list_folders') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  let directoryPath = (props.directoryPath ?? './').toString();
  const recursive = _toBool(props.recursive, false);
  const includeHidden = _toBool(props.includeHidden, false);
  const includeGlob = (props.includeGlob ?? '*').toString() || '*';
  const excludeGlob = (props.excludeGlob ?? '').toString() || '';
  const showDetails = _toBool(props.showDetails, false);
  let maxResults = _toInt(props.maxResults, 500);
  if (maxResults < 1) maxResults = 500;

  if (/[\n\r\0]/.test(directoryPath)) {
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
// Core list-folder operation
// ---------------------------------------------------------------------------

function _globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`);
}

function _matchesGlob(name: string, pattern: string): boolean {
  return _globToRegex(pattern).test(name);
}

function listFoldersFromPayload(payload: string | Record<string, any>, baseDir?: string): ExecutionResponse | string {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  baseDir = baseDir || process.cwd();
  const targetDir = data.directory_path;

  // Resolve target path.
  let fullDir: string;
  if (path.isAbsolute(targetDir)) {
    fullDir = targetDir;
  } else {
    fullDir = path.resolve(baseDir, targetDir);
  }

  // Safety check.
  const blocked = _isBlockedPath(fullDir);
  if (blocked) {
    return `Blocked path (contains '${blocked}'); refusing to list.`;
  }

  // Existence & type checks.
  if (!fs.existsSync(fullDir)) {
    return `Directory not found: ${fullDir}`;
  }
  if (!fs.statSync(fullDir).isDirectory()) {
    return `Path is not a directory: ${fullDir}`;
  }

  const includeGlob = data.include_glob;
  const excludeGlob = data.exclude_glob;
  const excludePatterns = excludeGlob
    ? excludeGlob.split(',').map((g: any) => g.toString().trim()).filter((g: any) => g.length > 0)
    : [];
  const maxResults = data.max_results;
  const showDetails = data.show_details;

  const entries: Array<string | [string, number, number]> = [];

  if (data.recursive) {
    // Walk the directory tree recursively, collecting subdirectories.
    const stack: string[] = [fullDir];
    while (stack.length > 0 && entries.length < maxResults) {
      const dir = stack.pop()!;
      let subDirs;
      try {
        subDirs = fs.readdirSync(dir, { withFileTypes: true }).filter((d: any) => d.isDirectory());
      } catch {
        continue;
      }
      for (const sub of subDirs) {
        const dname = sub.name;
        if (!data.include_hidden && dname.startsWith('.')) continue;
        if (includeGlob !== '*' && !_matchesGlob(dname, includeGlob)) continue;
        if (excludePatterns.some((pat: any) => _matchesGlob(dname, pat))) continue;

        const relPath = path.relative(fullDir, path.join(dir, dname));
        if (showDetails) {
          let size = 0, mtime = 0;
          try {
            const st = fs.statSync(path.join(dir, dname));
            size = st.size;
            mtime = Math.floor(st.mtimeMs / 1000);
          } catch {
            size = 0; mtime = 0;
          }
          entries.push([relPath, size, mtime]);
        } else {
          entries.push(relPath);
        }
        if (entries.length >= maxResults) break;

        // Only recurse into directories that we have already yielded?
        // Python's os.walk iterates all subdirectories; we push to stack too.
        stack.push(path.join(dir, dname));
      }
    }
  } else {
    // Flat listing.
    let names: string[];
    try {
      names = fs.readdirSync(fullDir);
    } catch (e: any) {
      return `Permission denied to read directory: ${fullDir}`;
    }
    for (const dname of names) {
      if (!data.include_hidden && dname.startsWith('.')) continue;
      if (includeGlob !== '*' && !_matchesGlob(dname, includeGlob)) continue;
      if (excludePatterns.some((pat: any) => _matchesGlob(dname, pat))) continue;

      const fullPath = path.join(fullDir, dname);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) continue;

      if (showDetails) {
        let size = 0, mtime = 0;
        try {
          const st = fs.statSync(fullPath);
          size = st.size;
          mtime = Math.floor(st.mtimeMs / 1000);
        } catch {
          size = 0; mtime = 0;
        }
        entries.push([dname, size, mtime]);
      } else {
        entries.push(dname);
      }
      if (entries.length >= maxResults) break;
    }
  }

  // Format output.
  const lines: string[] = [];
  if (entries.length === 0) {
    lines.push('(empty directory - no subfolders found)');
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

function skillFolderListExecute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return listFoldersFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): ExecutionResponse | string {
  return skillFolderListExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "list_folders";
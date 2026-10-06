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
  const low = p.toLowerCase();
  for (const frag of BLOCKED_PATH_FRAGMENTS) {
    if (low.includes(frag.toLowerCase())) {
      return frag;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

function _toBool(v: any, def: boolean = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  if (s === '') return def;
  return s === 'true';
}

function _toInt(v: any, def: number): number {
  try {
    const s = String(v).trim();
    if (!s) return def;
    const n = parseInt(s, 10);
    return isNaN(n) ? def : n;
  } catch {
    return def;
  }
}

const DEFAULT_EXCLUDES = '.git,node_modules,__pycache__,.venv,dist,build';

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'find_folder';
  if (action !== 'find_folder') {
    throw new Error(`Unsupported action: ${action}`);
  }

  if (!payload.properties || !Array.isArray(payload.properties)) {
    throw new Error("Missing 'properties' list in payload");
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties) {
    if (p.name !== undefined) props[p.name] = p.value ?? '';
  }

  const pattern = props.pattern ?? '';
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error("Missing required field: 'pattern'");
  }

  const target = ((props.path ?? '') as string).trim() || './';
  const recursive = _toBool(props.recursive ?? 'true', true);
  const isRegex = _toBool(props.isRegex ?? 'false', false);
  const caseSensitive = _toBool(props.caseSensitive ?? 'false', false);
  const includeGlob = ((props.includeGlob ?? '') as string).trim() || '*';
  const excludeGlob = ((props.excludeGlob ?? '') as string).trim() || DEFAULT_EXCLUDES;
  let maxResults = _toInt(props.maxResults ?? 100, 100);
  if (maxResults <= 0) maxResults = 100;
  const showPaths = _toBool(props.showPaths ?? 'true', true);

  const [sequential, nextPrompt] = getSequential(payload);
  const excludes = excludeGlob.split(',').map((g: any) => g.toString().trim()).filter(Boolean);

  return {
    action,
    pattern,
    path: target,
    recursive,
    is_regex: isRegex,
    case_sensitive: caseSensitive,
    include_glob: includeGlob,
    excludes,
    max_results: maxResults,
    show_paths: showPaths,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Directory walking / filtering (adapted for folders)
// ---------------------------------------------------------------------------

function _globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`);
}

function _matchesGlob(name: string, pattern: string): boolean {
  return _globToRegex(pattern).test(name);
}

function _matchesAnyGlob(name: string, patterns: string[]): boolean {
  return patterns.some((p: any) => _matchesGlob(name, p));
}

function* _iterDirs(root: string, recursive: boolean, includeGlob: string, excludes: string[]): Iterable<string> {
  if (recursive) {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (_matchesAnyGlob(entry.name, excludes)) continue;
        const full = path.join(dir, entry.name);
        if (_matchesGlob(entry.name, includeGlob)) yield full;
        stack.push(full);
      }
    }
  } else {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(root, name);
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) continue;
      if (_matchesAnyGlob(name, excludes)) continue;
      if (_matchesGlob(name, includeGlob)) yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Core find
// ---------------------------------------------------------------------------

function _dirnameMatches(dirname: string, pattern: string, isRegex: boolean, caseSensitive: boolean): boolean {
  if (isRegex) {
    try {
      return new RegExp(pattern, caseSensitive ? '' : 'i').test(dirname);
    } catch {
      return false;
    }
  } else {
    if (caseSensitive) {
      return _matchesGlob(dirname, pattern);
    } else {
      return _matchesGlob(dirname.toLowerCase(), pattern.toLowerCase());
    }
  }
}

function _wrapResponse(contentJson: string, sequential: any = null, nextPrompt: any = null): ExecutionResponse {
  return new ExecutionResponse(contentJson, nextPrompt, sequential, true);
}

function _errorResponse(msg: string, sequential: any = null, nextPrompt: any = null): ExecutionResponse {
  const contentJson = JSON.stringify({
    action: 'find_folder',
    status: 'error',
    message: msg,
    matches: [],
    totalMatchingFolders: 0,
    folderScanned: 0,
  }, null, 2);
  return _wrapResponse(contentJson, sequential, nextPrompt);
}

function findFoldersFromPayload(payload: string | Record<string, any>, baseDir?: string): ExecutionResponse {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return _errorResponse(`Invalid payload: ${e.message}`);
  }

  baseDir = baseDir || process.cwd();
  const target = data.path;
  const root = path.isAbsolute(target) ? target : path.resolve(baseDir, target);

  const blocked = _isBlockedPath(root);
  if (blocked) {
    return _errorResponse(`Blocked path (contains '${blocked}'); refusing to search.`, data.sequential, data.prompt);
  }

  if (!fs.existsSync(root)) {
    return _errorResponse(`Search path does not exist: ${root}`, data.sequential, data.prompt);
  }

  console.log(`folder finder: searching '${root}' for pattern='${data.pattern}' (regex=${data.is_regex}, case_sensitive=${data.case_sensitive})`);

  const matchedDirs: string[] = [];
  let scanned = 0;

  for (const dpath of _iterDirs(root, data.recursive, data.include_glob, data.excludes)) {
    scanned += 1;
    const dirname = path.basename(dpath);
    if (_dirnameMatches(dirname, data.pattern, data.is_regex, data.case_sensitive)) {
      if (data.show_paths) {
        matchedDirs.push(path.resolve(dpath));
      } else {
        matchedDirs.push(path.relative(root, dpath));
      }
      if (matchedDirs.length >= data.max_results) break;
    }
  }

  const folders = matchedDirs.length > 0 ? matchedDirs.join('\n') + '\n' : '';
  return _wrapResponse(folders, data.sequential, data.prompt);
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFolderFinderExecute(jsonPayload: string, baseDir: string = ''): ExecutionResponse {
  return findFoldersFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): ExecutionResponse {
  console.log('folder finder: running find with payload...');
  return skillFolderFinderExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "find_folder";
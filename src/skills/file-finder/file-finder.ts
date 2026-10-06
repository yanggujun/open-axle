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
  const action = payload.action ?? 'find_file';
  if (action !== 'find_file') {
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

  const excludes = excludeGlob.split(',').map((g: any) => g.trim()).filter(Boolean);

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
// Glob / regex helpers
// ---------------------------------------------------------------------------

function _globToRegex(glob: string, caseSensitive: boolean): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  const flags = caseSensitive ? '' : 'i';
  return new RegExp(`^${regexStr}$`, flags);
}

function _matchesGlob(name: string, pattern: string, caseSensitive: boolean = true): boolean {
  const re = _globToRegex(pattern, caseSensitive);
  return re.test(name);
}

function _matchesAnyGlob(name: string, patterns: string[], caseSensitive: boolean = true): boolean {
  return patterns.some((p: any) => _matchesGlob(name, p, caseSensitive));
}

function _filenameMatches(basename: string, pattern: string, isRegex: boolean, caseSensitive: boolean): boolean {
  if (isRegex) {
    try {
      const flags = caseSensitive ? '' : 'i';
      return new RegExp(pattern, flags).test(basename);
    } catch {
      return false;
    }
  } else {
    if (caseSensitive) {
      return _matchesGlob(basename, pattern, true);
    } else {
      return _matchesGlob(basename.toLowerCase(), pattern.toLowerCase(), false);
    }
  }
}

// ---------------------------------------------------------------------------
// File walking / filtering
// ---------------------------------------------------------------------------

function* _iterFiles(root: string, recursive: boolean, includeGlob: string, excludes: string[]): Iterable<string> {
  if (fs.existsSync(root) && fs.statSync(root).isFile()) {
    yield root;
    return;
  }

  if (!fs.existsSync(root)) return;

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
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!_matchesAnyGlob(entry.name, excludes)) {
            stack.push(full);
          }
        } else if (entry.isFile()) {
          if (_matchesAnyGlob(entry.name, excludes)) continue;
          if (!_matchesGlob(entry.name, includeGlob)) continue;
          yield full;
        }
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
      if (!fs.statSync(full).isFile()) continue;
      if (_matchesAnyGlob(name, excludes)) continue;
      if (!_matchesGlob(name, includeGlob)) continue;
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Core find
// ---------------------------------------------------------------------------

function _errorContentJson(msg: string): string {
  return JSON.stringify({
    action: 'find_file',
    status: 'error',
    message: msg,
    matches: [],
    totalMatchingFiles: 0,
    filesScanned: 0,
  }, null, 2);
}

function _wrapResponse(contentJson: string, sequential: any = null, nextPrompt: any = null): ExecutionResponse {
  return new ExecutionResponse(contentJson, nextPrompt, sequential, true);
}

function findFilesFromPayload(payload: string | Record<string, any>, baseDir?: string): ExecutionResponse {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return _wrapResponse(_errorContentJson(`Invalid payload: ${e.message}`));
  }

  baseDir = baseDir || process.cwd();
  const target = data.path;
  const root = path.isAbsolute(target) ? target : path.resolve(baseDir, target);

  const blocked = _isBlockedPath(root);
  if (blocked) {
    return _wrapResponse(
      _errorContentJson(`Blocked path (contains '${blocked}'); refusing to search.`),
      data.sequential,
      data.prompt
    );
  }

  if (!fs.existsSync(root)) {
    return _wrapResponse(
      _errorContentJson(`Search path does not exist: ${root}`),
      data.sequential,
      data.prompt
    );
  }

  console.log(`file finder: searching '${root}' for pattern='${data.pattern}' (regex=${data.is_regex}, case_sensitive=${data.case_sensitive})`);

  const matchedFiles: string[] = [];
  let scanned = 0;

  for (const fpath of _iterFiles(root, data.recursive, data.include_glob, data.excludes)) {
    scanned += 1;
    const basename = path.basename(fpath);
    if (_filenameMatches(basename, data.pattern, data.is_regex, data.case_sensitive)) {
      if (data.show_paths) {
        matchedFiles.push(path.resolve(fpath));
      } else {
        matchedFiles.push(path.relative(root, fpath));
      }
      if (matchedFiles.length >= data.max_results) break;
    }
  }

  if (matchedFiles.length === 0) {
    return _wrapResponse('No file is found', false);
  }

  const files = matchedFiles.join('\n') + '\n';
  return _wrapResponse(files, data.sequential, data.prompt);
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFileFinderExecute(jsonPayload: string, baseDir: string = ''): ExecutionResponse {
  return findFilesFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): ExecutionResponse {
  console.log('file finder: running find with payload...');
  return skillFileFinderExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "find_file";

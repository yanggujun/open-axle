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
  const action = payload.action ?? 'grep_file';
  if (action !== 'grep_file') {
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
  const showLines = _toBool(props.showLines ?? 'true', true);

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
    show_lines: showLines,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Glob matcher
// ---------------------------------------------------------------------------

function _globToRegex(glob: string, caseSensitive: boolean): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  const flags = caseSensitive ? '' : 'i';
  return new RegExp(`^${regexStr}$`, flags);
}

function _matchesGlob(name: string, pattern: string): boolean {
  return _globToRegex(pattern, true).test(name);
}

function _matchesAnyGlob(name: string, patterns: string[]): boolean {
  return patterns.some((p: any) => _matchesGlob(name, p));
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
  '.pyc', '.pyo',
]);

function _isProbablyBinary(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  if (BINARY_EXT.has(ext)) return true;
  try {
    const buf = fs.readFileSync(p);
    const chunk = buf.subarray(0, 2048);
    if (chunk.includes(0)) return true;
  } catch {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Directory iteration
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
// Core grep
// ---------------------------------------------------------------------------

function _searchFile(p: string, matcher: (line: string) => boolean, showLines: boolean): [number, string][] {
  const results: [number, string][] = [];
  try {
    const text = fs.readFileSync(p, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (matcher(line)) {
        if (showLines) {
          results.push([i + 1, line.replace(/\r$/, '')]);
        } else {
          results.push([i + 1, '']);
          break;
        }
      }
    }
  } catch {
    return results;
  }
  return results;
}

function _errorContentJson(msg: string): string {
  return JSON.stringify({
    action: 'grep_file',
    status: 'error',
    message: msg,
    matches: [],
    totalMatchingFiles: 0,
    totalLineMatches: 0,
    filesScanned: 0,
  }, null, 2);
}

function _wrapResponse(contentJson: string, sequential: any = null, nextPrompt: any = null): ExecutionResponse {
  return new ExecutionResponse(contentJson, nextPrompt, sequential, true);
}

function grepFromPayload(payload: string | Record<string, any>, baseDir?: string): ExecutionResponse {
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

  let matcher: (line: string) => boolean;
  if (data.is_regex) {
    try {
      const flags = data.case_sensitive ? '' : 'i';
      const regex = new RegExp(data.pattern, flags);
      matcher = (line: string) => regex.test(line);
    } catch (e: any) {
      return _wrapResponse(
        _errorContentJson(`Invalid regex pattern: ${e.message}`),
        data.sequential,
        data.prompt
      );
    }
  } else {
    const needle = data.case_sensitive ? data.pattern : data.pattern.toLowerCase();
    if (data.case_sensitive) {
      matcher = (line: string) => line.includes(needle);
    } else {
      matcher = (line: string) => line.toLowerCase().includes(needle);
    }
  }

  console.log(`file grep: searching '${root}' for pattern='${data.pattern}' (regex=${data.is_regex}, case_sensitive=${data.case_sensitive})`);

  const matchedFiles: [string, [number, string][]][] = [];
  let totalLineMatches = 0;
  let scanned = 0;

  for (const fpath of _iterFiles(root, data.recursive, data.include_glob, data.excludes)) {
    scanned += 1;
    if (_isProbablyBinary(fpath)) continue;
    const hits = _searchFile(fpath, matcher, data.show_lines);
    if (hits.length > 0) {
      matchedFiles.push([fpath, hits]);
      totalLineMatches += data.show_lines ? hits.length : 1;
      if (matchedFiles.length >= data.max_results) break;
    }
  }

  let files = '';
  for (const [fpath, hits] of matchedFiles) {
    files += fpath + '\n';
  }

  return _wrapResponse(files, data.sequential, data.prompt);
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFileGrepExecute(jsonPayload: string, baseDir: string = ''): ExecutionResponse {
  return grepFromPayload(jsonPayload, baseDir.trim() || undefined);
}

export function execute(jsonPayload: string, baseDir: string = ''): ExecutionResponse {
  return skillFileGrepExecute(jsonPayload, baseDir);
}

export const ACTION_NAME = "grep_file";
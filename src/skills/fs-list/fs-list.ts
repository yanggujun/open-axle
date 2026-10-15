// fs-list skill — combined file/folder listing equivalent to `ls`.
// PART 1: imports, safety, helpers, glob matching, payload normalization.

import * as fs from 'fs';
import * as path from 'path';
import { Runtime, ExecutionResponse, extractJson, getSequential, buildConnectConfig, connect, execCommand, shellQuote } from '../../common/common';

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
// Glob helpers
// ---------------------------------------------------------------------------

function _globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`);
}

function _matchesGlob(name: string, pattern: string): boolean {
  return _globToRegex(pattern).test(name);
}

// ---------------------------------------------------------------------------
// Payload validation & normalization
// ---------------------------------------------------------------------------

type FsEntryType = 'file' | 'folder' | 'both';

function _normalizeEntryType(value: any): FsEntryType {
  const v = value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  if (v === 'file' || v === 'files' || v === 'f') return 'file';
  if (v === 'folder' || v === 'folders' || v === 'dir' || v === 'dirs' || v === 'directory') return 'folder';
  return 'both';
}

function _normalize(payload: Record<string, any>): Record<string, any> {
  const action = payload.action ?? 'list_fs';
  const [sequential, nextPrompt] = getSequential(payload);

  if (action !== 'list_fs') {
    throw new Error(`Unsupported action: ${action}`);
  }

  const props: Record<string, any> = {};
  for (const p of payload.properties ?? []) {
    props[p.name] = p.value;
  }

  const directoryPath = (props.directoryPath ?? './').toString();
  const entryType = _normalizeEntryType(props.entryType);
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
    entry_type: entryType,
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
// Shared output formatting
// ---------------------------------------------------------------------------

// Row tuple: [typeChar ('f' | 'd'), displayName, size, mtime]
type FsRow = ['f' | 'd', string, number, number];

function _formatRows(rows: FsRow[], showDetails: boolean): string[] {
  const lines: string[] = [];
  if (rows.length === 0) return lines;
  if (showDetails) {
    lines.push(`${'Type'.padEnd(5)} ${'Name'.padEnd(40)} ${'Size'.padStart(10)} ${'Modified'.padStart(12)}`);
    lines.push('-'.repeat(70));
    for (const row of rows) {
      const t = row[0], name = row[1], size = row[2], mtime = row[3];
      const typeLabel = t === 'd' ? 'dir' : 'file';
      lines.push(`${typeLabel.padEnd(5)} ${name.padEnd(40)} ${String(size).padStart(10)} ${String(mtime).padStart(12)}`);
    }
  } else {
    for (const row of rows) {
      lines.push(row[1]);
    }
  }
  return lines;
}

function _emptyMessage(entryType: string): string {
  if (entryType === 'file') return '(empty directory - no files found)';
  if (entryType === 'folder') return '(empty directory - no subfolders found)';
  return '(empty directory)';
}

// ---------------------------------------------------------------------------
// Core list operation (local)
// ---------------------------------------------------------------------------

function listFsFromPayload(payload: string | Record<string, any>, runtime?: Runtime): ExecutionResponse | string {
  let data: Record<string, any>;
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  const baseDir = runtime?.workingDir?.path || process.cwd();
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
  const entryType = data.entry_type;

  const wantsFolders = entryType === 'folder' || entryType === 'both';
  const wantsFiles = entryType === 'file' || entryType === 'both';

  const rows: FsRow[] = [];

  const pushRow = (t: 'f' | 'd', display: string, fullPath: string) => {
    if (showDetails) {
      let size = 0, mtime = 0;
      try {
        const st = fs.statSync(fullPath);
        size = st.size;
        mtime = Math.floor(st.mtimeMs / 1000);
      } catch {
        size = 0; mtime = 0;
      }
      rows.push([t, display, size, mtime]);
    } else {
      // In 'both' non-details mode, suffix folders with '/' (like `ls -p`).
      rows.push([t, t === 'd' && entryType === 'both' ? display + '/' : display, 0, 0]);
    }
  };

  const accept = (name: string): boolean => {
    if (!data.include_hidden && name.startsWith('.')) return false;
    if (includeGlob !== '*' && !_matchesGlob(name, includeGlob)) return false;
    if (excludePatterns.some((pat: any) => _matchesGlob(name, pat))) return false;
    return true;
  };

  if (data.recursive) {
    // Walk the tree; always traverse directories, but only emit per entryType.
    const stack: string[] = [fullDir];
    while (stack.length > 0 && rows.length < maxResults) {
      const dir = stack.pop()!;
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const de of dirEntries) {
        const isDir = de.isDirectory();
        if (!isDir && !de.isFile()) continue;

        if (isDir) {
          // Always traverse into subdirectories so the walk covers the tree.
          if (data.include_hidden || !de.name.startsWith('.')) {
            if (wantsFolders && accept(de.name)) {
              const childPath = path.join(dir, de.name);
              const display = path.relative(fullDir, childPath);
              pushRow('d', display, childPath);
              if (rows.length >= maxResults) break;
            }
            stack.push(path.join(dir, de.name));
          }
        } else if (wantsFiles && accept(de.name)) {
          const childPath = path.join(dir, de.name);
          const display = path.relative(fullDir, childPath);
          pushRow('f', display, childPath);
          if (rows.length >= maxResults) break;
        }
      }
    }
  } else {
    // Flat listing.
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(fullDir, { withFileTypes: true });
    } catch (e: any) {
      return `Permission denied to read directory: ${fullDir}`;
    }
    for (const de of dirEntries) {
      const isDir = de.isDirectory();
      const isFile = de.isFile();
      if (!isDir && !isFile) continue;
      if (isDir && !wantsFolders) continue;
      if (isFile && !wantsFiles) continue;
      if (!accept(de.name)) continue;

      pushRow(isDir ? 'd' : 'f', de.name, path.join(fullDir, de.name));
      if (rows.length >= maxResults) break;
    }
  }

  // Format output.
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push(_emptyMessage(entryType));
  } else {
    for (const l of _formatRows(rows, showDetails)) {
      lines.push(l);
    }
  }

  const content = lines.join('\n');
  return new ExecutionResponse(content, data.prompt, data.sequential, true);
}

// ---------------------------------------------------------------------------
// Remote (SSH) list operation
// ---------------------------------------------------------------------------

async function listFsFromPayloadRemote(
  payload: string | Record<string, any>,
  runtime?: Runtime
): Promise<ExecutionResponse | string> {
  let data: Record<string, any>;
  const baseDir = runtime?.workingDir;
  const serverName = baseDir?.kind === 'remote' ? baseDir.serverName : '';
  const remoteBaseDir = baseDir?.path;
  const server = baseDir?.kind === 'remote' ? baseDir.server : {};
  try {
    const raw = extractJson(payload) ?? {};
    data = _normalize(raw);
  } catch (e: any) {
    return `Invalid payload: ${e.message}`;
  }

  if (!serverName) {
    return 'Missing remote server name for SSH execution.';
  }

  // Resolve the remote root (the remote host uses POSIX paths).
  const targetDir = data.directory_path;
  const fullDir = path.posix.isAbsolute(targetDir)
    ? targetDir
    : path.posix.resolve(remoteBaseDir || '.', targetDir);

  const blocked = _isBlockedPath(fullDir);
  if (blocked) {
    return `Blocked path (contains '${blocked}'); refusing to list.`;
  }

  const serverCfg = server;
  if (!serverCfg) {
    return `No SSH configuration found for server '${serverName}'.`;
  }

  const connectConfig = buildConnectConfig(serverName, serverCfg);

  const includeGlob = data.include_glob;
  const excludePatterns = data.exclude_glob
    ? data.exclude_glob.split(',').map((g: any) => g.toString().trim()).filter((g: any) => g.length > 0)
    : [];
  const maxResults = data.max_results;
  const showDetails = data.show_details;
  const entryType = data.entry_type;

  let conn = null as any;
  try {
    conn = await connect(connectConfig);

    // Build a remote `find` command enumerating files/directories per entryType.
    // Non-recursive walks stay at depth 1 via -maxdepth 1.
    const maxDepth = data.recursive ? '' : ' -maxdepth 1';
    const typeFilter = entryType === 'file'
      ? '-type f'
      : entryType === 'folder'
        ? '-type d'
        : '\\( -type d -o -type f \\)';
    const printf = showDetails
      ? '%y\\t%p\\t%s\\t%T@\\n'
      : '%y\\t%p\\n';
    const cmd = `find ${shellQuote(fullDir)}${maxDepth} ${typeFilter} -printf '${printf}' 2>/dev/null`;

    const { stdout } = await execCommand(conn, cmd);

    const rows: FsRow[] = [];
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;

      // details:   <type>	<path>	<size>	<mtime>
      // non-details: <type>	<path>
      const parts = line.split('\t');
      const typeChar: 'f' | 'd' = parts[0] === 'd' ? 'd' : 'f';
      const dpath = parts[1] || line;
      const size = parts[2] ? parseInt(parts[2], 10) : 0;
      const mtime = parts[3] ? Math.floor(parseFloat(parts[3])) : 0;

      if (dpath === fullDir) continue;

      const baseName = path.posix.basename(dpath);
      if (!data.include_hidden && baseName.startsWith('.')) continue;
      if (includeGlob !== '*' && !_matchesGlob(baseName, includeGlob)) continue;
      if (excludePatterns.some((pat: any) => _matchesGlob(baseName, pat))) continue;

      const displayName = data.recursive ? path.posix.relative(fullDir, dpath) : baseName;
      // In 'both' non-details mode, suffix folders with '/' (like `ls -p`).
      const display = typeChar === 'd' && entryType === 'both' && !showDetails
        ? displayName + '/'
        : displayName;

      if (showDetails) {
        rows.push([typeChar, display, size, mtime]);
      } else {
        rows.push([typeChar, display, 0, 0]);
      }
      if (rows.length >= maxResults) break;
    }

    // Format output.
    const outLines: string[] = [];
    if (rows.length === 0) {
      outLines.push(_emptyMessage(entryType));
    } else {
      for (const l of _formatRows(rows, showDetails)) {
        outLines.push(l);
      }
    }

    const content = outLines.join('\n');
    return new ExecutionResponse(content, data.prompt, data.sequential, true);
  } catch (e: any) {
    return `Failed to list remote entries over SSH: ${e.message}`;
  } finally {
    if (conn) {
      try { conn.end(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Skill wrapper functions (called by the SkillManager)
// ---------------------------------------------------------------------------

function skillFsListExecute(jsonPayload: string, runtime?: Runtime): ExecutionResponse | string {
  return listFsFromPayload(jsonPayload, runtime);
}

function skillFsListExecuteRemote(
  jsonPayload: string,
  runtime?: Runtime
): Promise<ExecutionResponse | string> {
  return listFsFromPayloadRemote(jsonPayload, runtime);
}

export function execute(jsonPayload: string, runtime: Runtime): ExecutionResponse | string | Promise<ExecutionResponse | string> {
  // Navigate the Runtime structure: the resolved working directory lives at
  // runtime.workingDir (kind, serverName, path, server).
  const workingDir = runtime?.workingDir;
  if (workingDir && workingDir.kind === 'remote') {
    return skillFsListExecuteRemote(jsonPayload, runtime);
  }
  return skillFsListExecute(jsonPayload, runtime);
}

export const ACTION_NAME = "list_fs";

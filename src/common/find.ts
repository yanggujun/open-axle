/**
 * find.ts -- a TypeScript port of a practical subset of GNU find(1).
 *
 * The behaviour (defaults, comparison rules, argument syntax and predicate
 * semantics) mirrors the GNU findutils C implementation:
 *
 *   find/pred.c    -- predicate evaluation (pred_size, pred_perm, pred_timewindow ...)
 *   find/parser.c  -- argument parsing (get_comp_type, get_num, parse_time ...)
 *   find/ftsfind.c -- traversal order, -depth, -prune, -maxdepth handling
 *   find/tree.c    -- expression tree / implicit AND / operator precedence
 *
 * Semantics that are reproduced faithfully:
 *
 *   - expression grammar:  comma < -o < -a (and implicit AND) < !/-not < primary
 *   - numeric comparisons: '+n' = greater than, '-n' = less than, 'n' = equal
 *   - -size rounds UP to the requested block size (default: 512-byte blocks)
 *   - -mtime/-mmin/-atime/-amin/-ctime/-cmin use the GNU time-window rule:
 *     for a plain 'n' a file matches when 0 < age - reference <= window
 *   - -perm accepts octal and symbolic modes plus the '-' and '/' prefixes
 *     (exact match, all-bits, any-bit; -perm /000 behaves like -perm -000)
 *   - -regex must match the WHOLE path, -name/-path/-iname/-ipath glob
 *   - traversal is pre-order (directory before its contents) unless -depth is
 *     given or -delete is used; -prune only has an effect in pre-order mode
 *   - the default symlink mode is -P (inspect the link, not its target)
 *
 * NAME MATCHING (the one intentional difference from GNU find)
 * ------------------------------------------------------------------------
 * GNU find needs -name '*abc*' to locate 1111abc11111.java.  Here a bare word
 * is treated as a *substring* pattern, because that is what "find the files
 * whose name contains abc" means:
 *
 *     await findFiles({ paths: ['.'], name: 'abc' });
 *     // -> ./1111abc11111.java, ./abc.txt, ./xabcy.java ...
 *
 * As soon as the pattern contains a glob metacharacter ('*', '?', '[', ']'
 * or a backslash) it is evaluated exactly like GNU find does.  Pass
 * nameMatchMode: 'glob' to force strict GNU behaviour, or 'substring' to
 * always substring-match.  -iname/-ipath behave the same but ignore case.
 *
 * Examples
 * ------------------------------------------------------------------------
 *     import { find, findFiles, findFilesByName, findFilesRegex } from './common/find';
 *
 *     // GNU style argv
 *     const r = await find(['.', '-name', 'abc', '-type', 'f']);
 *     console.log(r.output);   // './1111abc11111.java' + newline
 *     console.log(r.entries);  // structured matches
 *
 *     // semantic options
 *     const java = await findFilesRegex('src', '.*[.]java$');
 *     const big  = await findFiles({ paths: ['src'], size: '+10k' });
 */

import * as fs from 'fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'child_process';

/* -------------------------------------------------------------------------- */
/* Small character constants (kept out of literals to stay escape-safe)        */
/* -------------------------------------------------------------------------- */

/** A single backslash character. */
const BS = String.fromCharCode(92);
/** A NUL byte, used by -print0. */
const NUL = String.fromCharCode(0);
/** Line feed. */
const NL = '\n';
/** Horizontal tab. */
const TAB = '\t';
/** Regex fragment that matches any single character (including newline). */
const ANY_CHAR = '[^]';

/** All permission and set-id/sticky bits: 07777. */
export const PERM_ALL = 0o7777;
/** Number of seconds in a day, as used by -mtime/-atime/-ctime. */
export const DAY_SECONDS = 86400;
/** Number of seconds in a minute, as used by -mmin/-amin/-cmin. */
export const MINUTE_SECONDS = 60;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raised for invalid arguments / unparseable expressions, mirroring the fatal
 * errors GNU find reports while building the expression tree.
 */
export class FindError extends Error {
  readonly kind = 'find-error' as const;
  readonly code: string;

  constructor(message: string, code = 'EFIND') {
    super(message);
    this.name = 'FindError';
    this.code = code;
    Object.setPrototypeOf(this, FindError.prototype);
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/** Symlink handling, equivalent to GNU find's -P / -L / -H. */
export type SymlinkMode = 'P' | 'L' | 'H';

/** Result of a numeric comparison prefix: '+n' -> gt, '-n' -> lt, 'n' -> eq. */
export type ComparisonType = 'gt' | 'lt' | 'eq';

/** -perm flavour: exact mode, all bits set, or any bit set. */
export type PermissionKind = 'exact' | 'atleast' | 'any';

/** How a -name/-iname pattern is interpreted. */
export type NameMatchMode = 'auto' | 'glob' | 'substring';

/** One-character file type, as accepted by -type / -xtype. */
export type FileTypeChar = 'f' | 'd' | 'l' | 'b' | 'c' | 'p' | 's' | 'D' | '?';

/** Normalised stat(2) information (a JSON friendly subset of fs.Stats). */
export interface FindStat {
  /** Raw POSIX mode word: file type bits plus permission bits. */
  mode: number;
  ino: number;
  dev: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  /** Number of 512-byte blocks actually allocated. */
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  fileType: FileTypeChar;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  isBlockDevice: boolean;
  isCharacterDevice: boolean;
  isFIFO: boolean;
  isSocket: boolean;
}

/** A single entry produced by a traversal. */
export interface FindEntry {
  /** Path as reported by -print. */
  path: string;
  /** Basename of the entry. */
  name: string;
  /** Depth relative to the starting point; the starting point itself is 0. */
  depth: number;
  /** Starting point (command line path) that produced this entry. */
  startPath: string;
  /** Path of this entry relative to its starting point (used by %P). */
  relativePath: string;
  /** stat information of the entry, honouring the symlink mode. */
  stat: FindStat;
  /** Link target, when the entry is a symlink that was not followed. */
  linkTarget?: string;
  /** True when the entry is a command line starting point. */
  isStart: boolean;
}

/** A non-fatal error collected while traversing. */
export interface FindErrorInfo {
  path: string;
  code: string;
  message: string;
}

/** Result of a find run. */
export interface FindResult {
  /** Entries for which the whole expression evaluated to true. */
  entries: FindEntry[];
  /** Text produced by -print/-print0/-printf/-ls (and captured -exec output). */
  output: string;
  /** Non-fatal errors (unreadable directories, vanished files, ...). */
  errors: FindErrorInfo[];
  /** Paths removed by -delete. */
  deleted: string[];
  /** 0 on success, 1 when any error was reported (GNU find semantics). */
  exitCode: number;
  /** True when traversal stopped early because of -quit. */
  stopped: boolean;
  /** Number of entries examined. */
  visited: number;
}

/**
 * Options for {@link findFiles}.  Every field is optional; the defaults match
 * GNU find.  `paths` defaults to the current working directory.
 *
 * Fields map onto GNU find primaries and options: `name` -> -name,
 * `mtime` -> -mtime, `maxdepth` -> -maxdepth, `expression` -> the raw
 * expression tail, and so on.  When both a shorthand field and an equivalent
 * entry inside `expression` are supplied, the result is the logical AND of
 * both, exactly as if the shorthand had been written first on the command
 * line.
 */
export interface FindOptions {
  /** Starting point(s).  Default: ['.']. */
  paths?: string | string[];
  /** Raw GNU style expression tokens, e.g. ['-name', '*.ts', '-o', '-type', 'd']. */
  expression?: string[];

  /* --- name / path tests ------------------------------------------------ */
  name?: string | string[];
  iname?: string | string[];
  path?: string | string[];
  ipath?: string | string[];
  regex?: string | RegExp;
  iregex?: string | RegExp;
  /** Override how name/path patterns are interpreted.  Default: 'auto'. */
  nameMatchMode?: NameMatchMode;

  /* --- attribute tests -------------------------------------------------- */
  type?: string;
  xtype?: string;
  size?: string;
  perm?: string;
  user?: string | number;
  group?: string | number;
  uid?: string | number;
  gid?: string | number;
  links?: string | number;
  inum?: string | number;
  empty?: boolean;
  readable?: boolean;
  writable?: boolean;
  executable?: boolean;

  /* --- time tests ------------------------------------------------------- */
  mtime?: string;
  mmin?: string;
  atime?: string;
  amin?: string;
  ctime?: string;
  cmin?: string;
  /** -newer: mtime newer than the referenced file (or Date). */
  newer?: string | Date;
  anewer?: string | Date;
  cnewer?: string | Date;
  /** -newermt: mtime newer than a parsed date string. */
  newermt?: string | Date;

  /* --- traversal options ------------------------------------------------ */
  maxdepth?: number;
  mindepth?: number;
  /** -depth (a.k.a. -d): process directory contents before the directory. */
  depth?: boolean;
  /** -xdev / -mount: do not descend into other file systems. */
  xdev?: boolean;
  /** Symlink mode, -P (default), -L or -H. */
  symlink?: SymlinkMode;
  /** Shorthand for symlink: 'L'. */
  follow?: boolean;
  /** -daystart: measure -mtime/-atime/-ctime from the start of today. */
  daystart?: boolean;
  /** -ignore_readdir_race. */
  ignoreReaddirRace?: boolean;
  /** -regextype name (only 'posix-basic' triggers BRE translation). */
  regextype?: string;

  /* --- actions ---------------------------------------------------------- */
  print?: boolean;
  print0?: boolean;
  printf?: string;
  ls?: boolean;
  delete?: boolean;
  /** -exec CMD ... ;  (array form, or a shell-ish string). */
  exec?: string | string[];
  /** -execdir CMD ... ; */
  execdir?: string | string[];
  /** Stop after the first match (equivalent to appending -quit). */
  quitOnFirstMatch?: boolean;

  /* --- runtime ---------------------------------------------------------- */
  /** Upper bound on collected entries (safety valve). */
  maxResults?: number;
  /** Cooperative cancellation: polled before every entry. */
  signal?: { aborted: boolean };
  /** Called for every non-fatal error. */
  onError?: (err: FindErrorInfo) => void;
  /** Called with every chunk of action output. */
  onOutput?: (chunk: string) => void;
  /** Called for every matching entry, before it is stored. */
  onMatch?: (entry: FindEntry) => void;
  /** Where -exec sends its output.  Default: 'inherit'. */
  execStdio?: 'inherit' | 'capture' | 'ignore';
  /** Confirmation callback used by -ok / -okdir.  Default: always false. */
  confirm?: (command: string) => boolean | Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* Internal types shared by the parser, the walker and the formatters          */
/* -------------------------------------------------------------------------- */

/** Options with defaults applied (internal). */
export interface ResolvedOptions {
  paths: string[];
  maxdepth: number;
  mindepth: number;
  depth: boolean;
  explicitDepth: boolean;
  symlink: SymlinkMode;
  xdev: boolean;
  daystart: boolean;
  ignoreReaddirRace: boolean;
  nameMatchMode: NameMatchMode;
  regextype: string;
  startTimeMs: number;
  curDayStartMs: number;
  outputBlockSize: number;
  maxResults: number;
  execStdio: 'inherit' | 'capture' | 'ignore';
  signal?: { aborted: boolean };
  onError?: (err: FindErrorInfo) => void;
  onOutput?: (chunk: string) => void;
  onMatch?: (entry: FindEntry) => void;
  confirm?: (command: string) => boolean | Promise<boolean>;
}

/** Mutable run state (internal). */
export interface InternalState {
  options: ResolvedOptions;
  outputChunks: string[];
  entries: FindEntry[];
  errors: FindErrorInfo[];
  deleted: string[];
  exitCode: number;
  quit: boolean;
  /** Set by -prune for the directory currently being processed. */
  stopAtCurrentLevel: boolean;
  visited: number;
  /** Real uid of the process, used by -user/-uid. */
  uid: number;
  /** Login name of the current user, used to resolve -user <name>. */
  username: string;
  /** Pending -exec ... + argument batches. */
  execBatches: ExecBatch[];
}

/** A queued -exec ... + invocation (internal). */
export interface ExecBatch {
  argv: string[];
  dir: string;
  execdir: boolean;
}

/** Evaluation context handed to every predicate. */
export interface EvalContext {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly stat: FindStat;
  readonly isStart: boolean;
  readonly startPath: string;
  readonly relativePath: string;
  readonly linkTarget?: string;
  readonly options: ResolvedOptions;
  readonly state: InternalState;
  /** -prune: do not descend into this directory. */
  prune(): void;
  /** -quit: stop the whole traversal. */
  requestQuit(): void;
  /** Append text produced by an action. */
  write(text: string): void;
  /** -delete: remove the entry. */
  remove(): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* Name matching: glob + substring                                           */
/* -------------------------------------------------------------------------- */

const REGEXP_SPECIALS = BS + '^$.*+?()[]{}|/';
const globCache = new Map<string, RegExp>();

function escapeRegExpChar(ch: string): string {
  if (ch.length === 1 && REGEXP_SPECIALS.indexOf(ch) !== -1) {
    return BS + ch;
  }
  return ch;
}

function escapeRegExpClassChar(ch: string): string {
  if (ch === ']' || ch === BS || ch === '^' || ch === '[') {
    return BS + ch;
  }
  return ch;
}

/**
 * True when the pattern contains a glob metacharacter, i.e. when it must be
 * interpreted with fnmatch-like semantics instead of plain substring search.
 */
export function isGlobPattern(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === '*' || c === '?' || c === '[' || c === ']' || c === BS) {
      return true;
    }
  }
  return false;
}

/**
 * Translate an fnmatch(3) style glob into an anchored JavaScript RegExp.
 * Supports '*', '?', bracket expressions (with '!'/'^' negation and ranges)
 * and backslash escapes, matching GNU find's -name/-path/-lname behaviour,
 * including the fact that '*' also matches a '/'.
 */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
  const cacheKey = (ignoreCase ? 'i:' : 's:') + glob;
  const cached = globCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let src = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      src += ANY_CHAR + '*';
      i++;
      continue;
    }
    if (ch === '?') {
      src += ANY_CHAR;
      i++;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      let negated = false;
      if (glob.charAt(j) === '!' || glob.charAt(j) === '^') {
        negated = true;
        j++;
      }
      let body = '';
      let closed = false;
      if (glob.charAt(j) === ']') {
        body += BS + ']';
        j++;
      }
      while (j < glob.length) {
        const c = glob.charAt(j);
        if (c === ']') {
          closed = true;
          j++;
          break;
        }
        if (c === BS && j + 1 < glob.length) {
          body += BS + glob.charAt(j + 1);
          j += 2;
          continue;
        }
        if (c === '-') {
          body += '-';
          j++;
          continue;
        }
        body += escapeRegExpClassChar(c);
        j++;
      }
      if (!closed) {
        src += BS + '[';
        i++;
        continue;
      }
      src += '[' + (negated ? '^' : '') + body + ']';
      i = j;
      continue;
    }
    if (ch === BS) {
      const next = glob.charAt(i + 1);
      if (next) {
        src += escapeRegExpChar(next);
        i += 2;
      } else {
        src += escapeRegExpChar(BS);
        i++;
      }
      continue;
    }
    src += escapeRegExpChar(ch);
    i++;
  }
  src += '$';

  const re = new RegExp(src, ignoreCase ? 'i' : '');
  globCache.set(cacheKey, re);
  return re;
}

/**
 * Match a file name against a pattern.
 *
 * mode 'glob'      -- strict GNU find behaviour (fnmatch).
 * mode 'substring' -- the pattern must merely occur inside the name.
 * mode 'auto'      -- glob when the pattern has metacharacters, otherwise
 *                     substring, so 'abc' finds '1111abc11111.java'.
 */
export function matchesNamePattern(
  name: string,
  pattern: string,
  mode: NameMatchMode = 'auto',
  ignoreCase = false,
): boolean {
  const effective: NameMatchMode =
    mode === 'auto' ? (isGlobPattern(pattern) ? 'glob' : 'substring') : mode;
  if (effective === 'glob') {
    return globToRegExp(pattern, ignoreCase).test(name);
  }
  if (ignoreCase) {
    return name.toLowerCase().indexOf(pattern.toLowerCase()) !== -1;
  }
  return name.indexOf(pattern) !== -1;
}

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Left/right pad a string to a fixed width (ES6 has no padStart). */
export function padLeft(text: string, width: number, fill = ' '): string {
  let out = text;
  while (out.length < width) {
    out = fill + out;
  }
  return out;
}

/** Right pad a string to a fixed width. */
export function padRight(text: string, width: number, fill = ' '): string {
  let out = text;
  while (out.length < width) {
    out = out + fill;
  }
  return out;
}

/** Integer ceiling division; GNU's -size rounding rule. */
export function ceilDiv(value: number, divisor: number): number {
  if (divisor <= 0) {
    return value;
  }
  return Math.floor(value / divisor) + (value % divisor === 0 ? 0 : 1);
}

/** Zero-pad a non-negative integer to two digits. */
export function pad2(value: number): string {
  return value < 10 ? '0' + String(value) : String(value);
}

/** Numeric comparison as used by -size/-links/-inum/-uid/-gid. */
export function compareNumber(kind: ComparisonType, value: number, expected: number): boolean {
  if (kind === 'gt') {
    return value > expected;
  }
  if (kind === 'lt') {
    return value < expected;
  }
  return value === expected;
}

/* -------------------------------------------------------------------------- */
/* File types                                                                */
/* -------------------------------------------------------------------------- */

/** Extract the one-character file type from a POSIX mode word. */
export function statFileType(mode: number): FileTypeChar {
  const fmt = mode & 0o170000;
  switch (fmt) {
    case 0o040000:
      return 'd';
    case 0o100000:
      return 'f';
    case 0o120000:
      return 'l';
    case 0o060000:
      return 'b';
    case 0o020000:
      return 'c';
    case 0o010000:
      return 'p';
    case 0o140000:
      return 's';
    default:
      return '?';
  }
}

/** Human readable description of a file type character (GNU wording). */
export function fileTypeName(type: FileTypeChar): string {
  switch (type) {
    case 'f':
      return 'regular file';
    case 'd':
      return 'directory';
    case 'l':
      return 'symbolic link';
    case 'b':
      return 'block special file';
    case 'c':
      return 'character special file';
    case 'p':
      return 'fifo';
    case 's':
      return 'socket';
    case 'D':
      return 'door';
    default:
      return 'unknown';
  }
}

/** Render a POSIX mode word the way ls -l / find -ls does: 'drwxr-xr-x'. */
export function formatMode(mode: number): string {
  const type = statFileType(mode);
  let out = type === 'f' ? '-' : type === '?' ? '?' : type;
  const on = (mask: number, ch: string): string => ((mode & mask) !== 0 ? ch : '-');

  out += on(0o400, 'r') + on(0o200, 'w');
  if ((mode & 0o4000) !== 0) {
    out += (mode & 0o100) !== 0 ? 's' : 'S';
  } else {
    out += on(0o100, 'x');
  }

  out += on(0o040, 'r') + on(0o020, 'w');
  if ((mode & 0o2000) !== 0) {
    out += (mode & 0o010) !== 0 ? 's' : 'S';
  } else {
    out += on(0o010, 'x');
  }

  out += on(0o004, 'r') + on(0o002, 'w');
  if ((mode & 0o1000) !== 0) {
    out += (mode & 0o001) !== 0 ? 't' : 'T';
  } else {
    out += on(0o001, 'x');
  }

  return out;
}

/** Convert an fs.Stats object into the JSON friendly FindStat shape. */
export function normalizeStat(st: fs.Stats): FindStat {
  const mode = st.mode;
  const type = statFileType(mode);
  const anyStats = st as unknown as Record<string, number>;
  const blocks =
    typeof anyStats.blocks === 'number' ? anyStats.blocks : ceilDiv(st.size, 512);
  return {
    mode,
    ino: st.ino,
    dev: st.dev,
    nlink: st.nlink,
    uid: st.uid,
    gid: st.gid,
    rdev: st.rdev,
    size: st.size,
    blocks,
    atimeMs: st.atimeMs,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    birthtimeMs: typeof anyStats.birthtimeMs === 'number' ? anyStats.birthtimeMs : 0,
    fileType: type,
    isDirectory: type === 'd',
    isFile: type === 'f',
    isSymbolicLink: type === 'l',
    isBlockDevice: type === 'b',
    isCharacterDevice: type === 'c',
    isFIFO: type === 'p',
    isSocket: type === 's',
  };
}

/* -------------------------------------------------------------------------- */
/* Timestamp formatting (GNU %t / %a / %c and find -ls)                       */
/* -------------------------------------------------------------------------- */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** ctime(3) style rendering, including nanoseconds: 'Wed Nov 12 10:30:00.0000000000 2025'. */
export function formatCtime(ms: number): string {
  if (!isFinite(ms) || ms === 0) {
    return 'Thu Jan  1 00:00:00.0000000000 1970';
  }
  const d = new Date(ms);
  const day = DAY_NAMES[d.getDay()];
  const month = MONTH_NAMES[d.getMonth()];
  const dateStr = padLeft(String(d.getDate()), 2);
  const hhmmss =
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  const nanos = padLeft(String((((ms % 1000) + 1000) % 1000) * 1000000), 9, '0');
  return (
    day + ' ' + month + ' ' + dateStr + ' ' + hhmmss + '.' + nanos + ' ' + String(d.getFullYear())
  );
}

/** ls -l style date: 'Nov 12 10:30' when recent, 'Nov 12  2024' otherwise. */
export function formatLsTime(ms: number, nowMs: number): string {
  if (!isFinite(ms) || ms === 0) {
    return 'Jan  1  1970';
  }
  const d = new Date(ms);
  const month = MONTH_NAMES[d.getMonth()];
  const dateStr = padLeft(String(d.getDate()), 2);
  const sixMonths = 182 * 24 * 3600 * 1000;
  if (ms > nowMs - sixMonths && ms < nowMs + 3600 * 1000) {
    return month + ' ' + dateStr + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  return month + ' ' + dateStr + '  ' + String(d.getFullYear());
}

/* -------------------------------------------------------------------------- */
/* chmod-style mode compilation (used by -perm)                              */
/* -------------------------------------------------------------------------- */

/** One clause of a symbolic mode, e.g. 'u+w' or '/111'. */
export interface ModeChange {
  op: '+' | '-' | '=';
  /** Bit mask of the selected who classes (u/g/o expanded, incl. s/t bits). */
  who: number;
  /** Permission bits selected by the clause. */
  perms: number;
  /** Execute bits belonging to the selected who classes. */
  execMask: number;
  /** True when an 'X' was present (conditional execute). */
  conditionalX: boolean;
}

const WHO_U = 0o4700;
const WHO_G = 0o2070;
const WHO_O = 0o1007;
const WHO_ALL = 0o7777;

/**
 * Compile a chmod-style mode string (octal '0644' or symbolic 'u=rwx,go=rx')
 * into a list of changes.  Copy semantics ('g=u') are not supported.
 */
export function compileMode(spec: string): ModeChange[] {
  if (!spec) {
    throw new FindError('invalid file mode: empty mode string');
  }
  const changes: ModeChange[] = [];
  const clauses = spec.split(',');
  for (let c = 0; c < clauses.length; c++) {
    let clause = clauses[c];
    if (!clause) {
      throw new FindError('invalid file mode: ' + spec);
    }
    let who = 0;
    let sawWho = false;
    while (clause.length > 0 && 'ugoa'.indexOf(clause.charAt(0)) !== -1) {
      const ch = clause.charAt(0);
      sawWho = true;
      if (ch === 'u') {
        who |= WHO_U;
      } else if (ch === 'g') {
        who |= WHO_G;
      } else if (ch === 'o') {
        who |= WHO_O;
      } else {
        who |= WHO_ALL;
      }
      clause = clause.slice(1);
    }
    if (!sawWho) {
      who = WHO_ALL;
    }
    const opChar = clause.charAt(0);
    if (opChar !== '+' && opChar !== '-' && opChar !== '=') {
      throw new FindError('invalid file mode: ' + spec);
    }
    clause = clause.slice(1);

    let perms = 0;
    let execMask = 0;
    let conditionalX = false;
    for (let i = 0; i < clause.length; i++) {
      const ch = clause.charAt(i);
      if (ch === 'r') {
        perms |= who & 0o444;
      } else if (ch === 'w') {
        perms |= who & 0o222;
      } else if (ch === 'x') {
        perms |= who & 0o111;
        execMask |= who & 0o111;
      } else if (ch === 'X') {
        conditionalX = true;
        execMask |= who & 0o111;
      } else if (ch === 's') {
        perms |= who & 0o6000;
      } else if (ch === 't') {
        perms |= who & 0o1000;
      } else if (ch === 'u' || ch === 'g' || ch === 'o') {
        throw new FindError(
          'copying permissions is not supported in -perm mode: ' + spec,
        );
      } else {
        throw new FindError('invalid file mode: ' + spec);
      }
    }
    changes.push({
      op: opChar as '+' | '-' | '=',
      who,
      perms,
      execMask,
      conditionalX,
    });
  }
  return changes;
}

/** Apply compiled mode changes to a mode word (mode_adjust(3) equivalent). */
export function adjustMode(changes: ModeChange[], base: number, isDirectory: boolean): number {
  let mode = base;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    let bits = change.perms;
    if (change.execMask !== 0) {
      const explicitX = (bits & change.execMask) !== 0;
      const conditional = change.conditionalX && (isDirectory || (base & 0o111) !== 0);
      if (explicitX || conditional) {
        bits |= change.execMask;
      } else {
        bits &= ~change.execMask;
      }
    }
    if (change.op === '+') {
      mode |= bits;
    } else if (change.op === '-') {
      mode &= ~bits;
    } else {
      mode = (mode & ~change.who) | (bits & change.who);
    }
  }
  return mode & PERM_ALL;
}

/** A parsed -perm argument. */
export interface PermSpec {
  kind: PermissionKind;
  /** Mode bits to test for non-directories. */
  value: number;
  /** Mode bits to test for directories (differs only for X in symbolic modes). */
  valueDir: number;
  raw: string;
}

/** Parse a -perm argument, including the '-mode' and '/mode' prefixes. */
export function parsePermSpec(arg: string): PermSpec {
  let kind: PermissionKind = 'exact';
  let body = arg;
  if (arg.charAt(0) === '-') {
    kind = 'atleast';
    body = arg.slice(1);
  } else if (arg.charAt(0) === '/') {
    kind = 'any';
    body = arg.slice(1);
  }
  if (!body) {
    throw new FindError('invalid file mode: ' + arg);
  }

  if (/^[0-7]+$/.test(body)) {
    const value = parseInt(body, 8) & PERM_ALL;
    return { kind, value, valueDir: value, raw: arg };
  }

  const changes = compileMode(body);
  const value = adjustMode(changes, 0, false);
  const valueDir = adjustMode(changes, 0, true);
  let effectiveKind = kind;
  if (effectiveKind === 'any' && value === 0 && valueDir === 0) {
    // GNU find: -perm /000 behaves like -perm -000 (matches everything).
    effectiveKind = 'atleast';
  }
  return { kind: effectiveKind, value, valueDir, raw: arg };
}

/** Evaluate a -perm test against a mode word. */
export function permMatches(spec: PermSpec, mode: number): boolean {
  const isDir = statFileType(mode) === 'd';
  const wanted = isDir ? spec.valueDir : spec.value;
  if (spec.kind === 'atleast') {
    return (mode & wanted) === wanted;
  }
  if (spec.kind === 'any') {
    if (wanted === 0) {
      return true;
    }
    return (mode & wanted) !== 0;
  }
  return (mode & PERM_ALL) === wanted;
}

/* -------------------------------------------------------------------------- */
/* Numeric / size / time argument parsing                                    */
/* -------------------------------------------------------------------------- */

/**
 * Strip an optional comparison prefix from a numeric argument, mirroring
 * GNU's get_comp_type(): '+' means greater, '-' means less, no prefix equals.
 */
export function parseComparisonPrefix(arg: string): { cmp: ComparisonType; rest: string } {
  const first = arg.charAt(0);
  if (first === '+') {
    return { cmp: 'gt', rest: arg.slice(1) };
  }
  if (first === '-') {
    return { cmp: 'lt', rest: arg.slice(1) };
  }
  return { cmp: 'eq', rest: arg };
}

/** Parse a strictly unsigned decimal argument (GNU's xstrtoumax with base 10). */
export function parseUintArg(arg: string, what: string): number {
  if (!arg) {
    throw new FindError('missing numeric argument for ' + what);
  }
  if (!/^[0-9]+$/.test(arg)) {
    throw new FindError('non-numeric argument to ' + what + ': ' + arg);
  }
  const value = Number(arg);
  if (!isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
    throw new FindError('numeric argument too large for ' + what + ': ' + arg);
  }
  return value;
}

/** Parse a numeric predicate argument such as '+5', '-1' or '42'. */
export function parseNumberSpec(arg: string, what: string): { cmp: ComparisonType; value: number } {
  const { cmp, rest } = parseComparisonPrefix(arg);
  return { cmp, value: parseUintArg(rest, what) };
}

/** Suffix table for -size, from parse_size() in parser.c. */
const SIZE_SUFFIXES: { [suffix: string]: number } = {
  b: 512,
  c: 1,
  w: 2,
  k: 1024,
  M: 1024 * 1024,
  G: 1024 * 1024 * 1024,
};

/** A parsed -size argument. */
export interface SizeSpec {
  cmp: ComparisonType;
  /** Requested number of blocks. */
  blocks: number;
  /** Size of one block in bytes (512 unless a suffix says otherwise). */
  blockSize: number;
}

/**
 * Parse -size, e.g. '10k', '+1M', '-512c' or '3'.  A missing suffix means
 * 512-byte blocks, exactly like GNU find.
 */
export function parseSizeSpec(arg: string): SizeSpec {
  let text = arg;
  let blockSize = 512;
  if (!text) {
    throw new FindError('invalid null argument to -size');
  }
  const last = text.charAt(text.length - 1);
  if (last >= '0' && last <= '9') {
    // No suffix: 512-byte blocks.
  } else if (SIZE_SUFFIXES[last] !== undefined) {
    blockSize = SIZE_SUFFIXES[last];
    text = text.slice(0, text.length - 1);
  } else {
    throw new FindError("invalid -size type '" + last + "'");
  }
  const { cmp, rest } = parseComparisonPrefix(text);
  const blocks = parseUintArg(rest, '-size');
  return { cmp, blocks, blockSize };
}

/** Evaluate -size: the file size rounded up to the requested block size. */
export function sizeMatches(spec: SizeSpec, size: number): boolean {
  return compareNumber(spec.cmp, ceilDiv(size, spec.blockSize), spec.blocks);
}

/** A parsed time predicate (-mtime/-mmin/-atime/...). */
export interface TimeSpec {
  cmp: ComparisonType;
  /** Reference point in epoch milliseconds. */
  refMs: number;
  /** Window length in milliseconds (86400000 or 60000). */
  windowMs: number;
}

/**
 * Parse a time predicate argument.
 *
 * originMs is GNU's options.cur_day_start: the moment the program started
 * minus one day, or the start of today when -daystart is in effect.
 *
 * For day based predicates GNU shifts the origin by (DAYSECS - 1) seconds when
 * the comparison is '-' (less than), see parse_time() in parser.c.
 */
export function parseTimeSpec(
  arg: string,
  unitSeconds: number,
  originMs: number,
  shiftOriginForLessThan: boolean,
): TimeSpec {
  const { cmp, rest } = parseComparisonPrefix(arg);
  const amount = parseUintArg(rest, 'time predicate');
  let origin = originMs;
  if (shiftOriginForLessThan && cmp === 'lt') {
    origin += unitSeconds * 1000 - 1000;
  }
  const windowMs = unitSeconds * 1000;
  return { cmp, refMs: origin - amount * windowMs, windowMs };
}

/**
 * GNU's pred_timewindow(): for an exact match the age must be strictly greater
 * than the reference point and at most one window later.
 */
export function timeWindowMatches(valueMs: number, spec: TimeSpec): boolean {
  if (spec.cmp === 'gt') {
    return valueMs > spec.refMs;
  }
  if (spec.cmp === 'lt') {
    return valueMs < spec.refMs;
  }
  const delta = valueMs - spec.refMs;
  return delta > 0 && delta <= spec.windowMs;
}

/* -------------------------------------------------------------------------- */
/* Process identity helpers (used by -user / -uid)                            */
/* -------------------------------------------------------------------------- */

/** Real uid of this process, or -1 when unavailable (Windows). */
export function currentUserId(): number {
  const getuid = (process as unknown as { getuid?: () => number }).getuid;
  if (typeof getuid === 'function') {
    try {
      return getuid();
    } catch {
      return -1;
    }
  }
  return -1;
}

/** Login name of this process, or '' when unavailable. */
export function currentUserName(): string {
  try {
    const info = os.userInfo();
    return info && info.username ? info.username : '';
  } catch {
    return '';
  }
}

/** Local midnight (start of today) for the given epoch milliseconds. */
export function startOfToday(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* -------------------------------------------------------------------------- */
/* User and group name resolution                                            */
/* -------------------------------------------------------------------------- */

interface UserRecord {
  name: string;
  uid: number;
  gid: number;
}

interface GroupRecord {
  name: string;
  gid: number;
}

let userTable: UserRecord[] | null = null;
let groupTable: GroupRecord[] | null = null;

/**
 * Load /etc/passwd once.  On platforms without it (Windows) the table stays
 * empty and callers fall back to the current process identity.
 */
function loadUserTable(): UserRecord[] {
  if (userTable) {
    return userTable;
  }
  const table: UserRecord[] = [];
  try {
    const text = fs.readFileSync('/etc/passwd', 'utf8');
    const lines = text.split(NL);
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(':');
      if (parts.length >= 4) {
        const uid = parseInt(parts[2], 10);
        const gid = parseInt(parts[3], 10);
        if (!isNaN(uid) && !isNaN(gid)) {
          table.push({ name: parts[0], uid: uid, gid: gid });
        }
      }
    }
  } catch (err) {
    /* /etc/passwd unavailable: leave the table empty. */
  }
  userTable = table;
  return table;
}

/** Load /etc/group once (empty on platforms without it). */
function loadGroupTable(): GroupRecord[] {
  if (groupTable) {
    return groupTable;
  }
  const table: GroupRecord[] = [];
  try {
    const text = fs.readFileSync('/etc/group', 'utf8');
    const lines = text.split(NL);
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(':');
      if (parts.length >= 3) {
        const gid = parseInt(parts[2], 10);
        if (!isNaN(gid)) {
          table.push({ name: parts[0], gid: gid });
        }
      }
    }
  } catch (err) {
    /* /etc/group unavailable. */
  }
  groupTable = table;
  return table;
}

/** Resolve a uid to a login name ('' when the uid has no name). */
export function userNameOf(uid: number): string {
  const table = loadUserTable();
  for (let i = 0; i < table.length; i++) {
    if (table[i].uid === uid) {
      return table[i].name;
    }
  }
  if (uid === currentUserId()) {
    return currentUserName();
  }
  return '';
}

/** Resolve a gid to a group name ('' when the gid has no name). */
export function groupNameOf(gid: number): string {
  const table = loadGroupTable();
  for (let i = 0; i < table.length; i++) {
    if (table[i].gid === gid) {
      return table[i].name;
    }
  }
  return '';
}

/**
 * Resolve the argument of -user: a numeric uid or a login name.
 * Throws when the name is unknown, exactly like GNU find.
 */
export function resolveUid(spec: string | number): number {
  if (typeof spec === 'number') {
    return spec;
  }
  const text = String(spec);
  if (/^[0-9]+$/.test(text)) {
    return parseInt(text, 10);
  }
  const table = loadUserTable();
  for (let i = 0; i < table.length; i++) {
    if (table[i].name === text) {
      return table[i].uid;
    }
  }
  const current = currentUserName();
  if (current && current.toLowerCase() === text.toLowerCase()) {
    return currentUserId();
  }
  throw new FindError("'" + text + "' is not the name of a known user");
}

/** Resolve the argument of -group: a numeric gid or a group name. */
export function resolveGid(spec: string | number): number {
  if (typeof spec === 'number') {
    return spec;
  }
  const text = String(spec);
  if (/^[0-9]+$/.test(text)) {
    return parseInt(text, 10);
  }
  const table = loadGroupTable();
  for (let i = 0; i < table.length; i++) {
    if (table[i].name === text) {
      return table[i].gid;
    }
  }
  throw new FindError("'" + text + "' is not the name of a known group");
}

/* -------------------------------------------------------------------------- */
/* Calendar helpers used by the time directives                              */
/* -------------------------------------------------------------------------- */

const WEEKDAY_FULL = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** 1-based day of the year. */
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.floor((d.getTime() - start.getTime()) / 86400000) + 1;
}

/** ISO-8601 week number and week-based year. */
function isoWeekParts(d: Date): { year: number; week: number } {
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (thursday.getDay() + 6) % 7;
  thursday.setDate(thursday.getDate() - dayNum + 3);
  const isoYear = thursday.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week =
    1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604800000);
  return { year: isoYear, week: week };
}

/** Week number with Sunday as the first day (strftime %U). */
function weekNumberSunday(d: Date): number {
  const yday = dayOfYear(d) - 1;
  return Math.floor((yday + 7 - d.getDay()) / 7);
}

/** Week number with Monday as the first day (strftime %W). */
function weekNumberMonday(d: Date): number {
  const yday = dayOfYear(d) - 1;
  return Math.floor((yday + 7 - ((d.getDay() + 6) % 7)) / 7);
}

/** A stable, locale independent time-zone label such as 'GMT+01:00'. */
function timeZoneName(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return 'GMT' + sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

/** Implement the single-character strftime directives GNU find accepts. */
export function strftime(ms: number, directive: string): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = d.getMonth();
  const dayOfMonth = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();
  const dayOfWeek = d.getDay();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const iso = isoWeekParts(d);

  switch (directive) {
    case 'a':
      return DAY_NAMES[dayOfWeek];
    case 'A':
      return WEEKDAY_FULL[dayOfWeek];
    case 'b':
    case 'h':
      return MONTH_NAMES[month];
    case 'B':
      return MONTH_FULL[month];
    case 'c':
      return formatCtime(ms);
    case 'C':
      return padLeft(String(Math.floor(year / 100)), 2, '0');
    case 'd':
      return pad2(dayOfMonth);
    case 'D':
      return pad2(month + 1) + '/' + pad2(dayOfMonth) + '/' +
        padLeft(String(year % 100), 2, '0');
    case 'e':
      return padLeft(String(dayOfMonth), 2);
    case 'F':
      return String(year) + '-' + pad2(month + 1) + '-' + pad2(dayOfMonth);
    case 'g':
      return padLeft(String(iso.year % 100), 2, '0');
    case 'G':
      return String(iso.year);
    case 'H':
      return pad2(hours);
    case 'I':
      return pad2(hour12);
    case 'j':
      return padLeft(String(dayOfYear(d)), 3, '0');
    case 'k':
      return padLeft(String(hours), 2);
    case 'l':
      return padLeft(String(hour12), 2);
    case 'm':
      return pad2(month + 1);
    case 'M':
      return pad2(minutes);
    case 'n':
      return NL;
    case 'p':
      return hours < 12 ? 'AM' : 'PM';
    case 'r':
      return pad2(hour12) + ':' + pad2(minutes) + ':' + pad2(seconds) +
        (hours < 12 ? ' AM' : ' PM');
    case 'S':
      return pad2(seconds);
    case 't':
      return TAB;
    case 'T':
      return pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
    case 'u':
      return String(dayOfWeek === 0 ? 7 : dayOfWeek);
    case 'U':
      return pad2(weekNumberSunday(d));
    case 'V':
      return pad2(iso.week);
    case 'w':
      return String(dayOfWeek);
    case 'W':
      return pad2(weekNumberMonday(d));
    case 'x':
      return pad2(month + 1) + '/' + pad2(dayOfMonth) + '/' +
        padLeft(String(year % 100), 2, '0');
    case 'X':
      return pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
    case 'y':
      return padLeft(String(year % 100), 2, '0');
    case 'Y':
      return String(year);
    case 'Z':
      return timeZoneName(d);
    default:
      return '';
  }
}

/**
 * Render a timestamp for the %A/%C/%T family.  Besides the strftime
 * characters this supports GNU's two special values:
 *
 *   '@'  seconds since the epoch with a fractional part
 *   '+'  date and time with a fractional part, e.g. 2025-11-12+10:30:00.0
 */
export function formatTimeValue(ms: number, directive: string): string {
  const seconds = Math.floor(ms / 1000);
  const nanos = Math.round((ms - seconds * 1000) * 1000000);
  if (directive === '@') {
    return String(seconds) + '.' + padLeft(String(nanos), 10, '0');
  }
  if (directive === '+') {
    return strftime(ms, 'F') + '+' + strftime(ms, 'T') + '.' +
      padLeft(String(nanos), 10, '0');
  }
  return strftime(ms, directive);
}

/* -------------------------------------------------------------------------- */
/* The -printf engine                                                        */
/* -------------------------------------------------------------------------- */

/** Context extended with information only the walker can supply. */
export interface ExtendedContext extends EvalContext {
  /** File type of the symlink target, for %Y ('N' when it does not exist). */
  targetType?: FileTypeChar;
  /** Filesystem type name, for %F. */
  fsType?: string;
}

/** Directory part of a path, the way GNU's %h renders it. */
export function dirNameOf(p: string): string {
  const dir = path.dirname(p);
  return dir === '' ? '.' : dir;
}

/**
 * Expand a -printf format string for one entry.
 *
 * Supported directives: %a %A %b %c %C %d %D %f %F %g %G %h %H %i %k %l %m
 * %M %n %p %P %s %t %T %u %U %y %Y %Z and %%.  Flags '-', '0', '+', ' ' and
 * '#' plus a field width and a precision are honoured for numeric and string
 * directives, matching GNU's behaviour.
 */
export function formatPrintf(format: string, ctx: ExtendedContext): string {
  const st = ctx.stat;
  let out = '';
  let i = 0;

  while (i < format.length) {
    const ch = format.charAt(i);
    if (ch !== '%') {
      out += ch;
      i++;
      continue;
    }
    i++;
    if (i >= format.length) {
      out += '%';
      break;
    }
    if (format.charAt(i) === '%') {
      out += '%';
      i++;
      continue;
    }

    let flags = '';
    while (i < format.length && '-+ 0#'.indexOf(format.charAt(i)) !== -1) {
      flags += format.charAt(i);
      i++;
    }
    let widthText = '';
    while (i < format.length && format.charAt(i) >= '0' && format.charAt(i) <= '9') {
      widthText += format.charAt(i);
      i++;
    }
    let precisionText = '';
    if (i < format.length && format.charAt(i) === '.') {
      i++;
      while (i < format.length && format.charAt(i) >= '0' && format.charAt(i) <= '9') {
        precisionText += format.charAt(i);
        i++;
      }
    }

    const directive = format.charAt(i);
    i++;

    let value = '';
    let numeric = false;
    switch (directive) {
      case 'a':
        value = formatCtime(st.atimeMs);
        break;
      case 'A': {
        const k = format.charAt(i);
        i++;
        value = formatTimeValue(st.atimeMs, k);
        break;
      }
      case 'b':
        value = String(st.blocks);
        numeric = true;
        break;
      case 'c':
        value = formatCtime(st.ctimeMs);
        break;
      case 'C': {
        const k = format.charAt(i);
        i++;
        value = formatTimeValue(st.ctimeMs, k);
        break;
      }
      case 'd':
        value = String(ctx.depth);
        numeric = true;
        break;
      case 'D':
        value = String(st.dev);
        numeric = true;
        break;
      case 'f':
        value = ctx.name;
        break;
      case 'F':
        value = ctx.fsType || '';
        break;
      case 'g':
        value = groupNameOf(st.gid);
        break;
      case 'G':
        value = String(st.gid);
        numeric = true;
        break;
      case 'h':
        value = dirNameOf(ctx.path);
        break;
      case 'H':
        value = ctx.startPath;
        break;
      case 'i':
        value = String(st.ino);
        numeric = true;
        break;
      case 'k':
        value = String(ceilDiv(st.size, 1024));
        numeric = true;
        break;
      case 'l':
        value = ctx.linkTarget || '';
        break;
      case 'm':
        value = (st.mode & PERM_ALL).toString(8);
        break;
      case 'M':
        value = formatMode(st.mode);
        break;
      case 'n':
        value = String(st.nlink);
        numeric = true;
        break;
      case 'p':
        value = ctx.path;
        break;
      case 'P':
        value = ctx.relativePath;
        break;
      case 's':
        value = String(st.size);
        numeric = true;
        break;
      case 't':
        value = formatCtime(st.mtimeMs);
        break;
      case 'T': {
        const k = format.charAt(i);
        i++;
        value = formatTimeValue(st.mtimeMs, k);
        break;
      }
      case 'u':
        value = userNameOf(st.uid);
        break;
      case 'U':
        value = String(st.uid);
        numeric = true;
        break;
      case 'y':
        value = st.fileType;
        break;
      case 'Y':
        value = ctx.targetType || 'N';
        break;
      case 'Z':
        value = '';
        break;
      default:
        value = '%' + directive;
        break;
    }

    if (precisionText) {
      const precision = parseInt(precisionText, 10);
      if (!isNaN(precision) && value.length > precision) {
        value = value.slice(0, precision);
      }
    }
    if (widthText) {
      const width = parseInt(widthText, 10);
      if (!isNaN(width) && value.length < width) {
        if (flags.indexOf('-') !== -1) {
          value = padRight(value, width);
        } else if (numeric && flags.indexOf('0') !== -1) {
          value = padLeft(value, width, '0');
        } else {
          value = padLeft(value, width);
        }
      }
    }
    out += value;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* The -ls line formatter                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build one find -ls line.  The column layout follows GNU's list_file()
 * closely enough to be readable and diffable: inode, blocks, mode, links,
 * owner, group, size, date, name (with ' -> target' for symlinks).
 */
export function formatLsLine(ctx: EvalContext, nowMs: number): string {
  const st = ctx.stat;
  const owner = userNameOf(st.uid) || String(st.uid);
  const group = groupNameOf(st.gid) || String(st.gid);
  let name = ctx.path;
  if (ctx.linkTarget) {
    name = name + ' -> ' + ctx.linkTarget;
  }
  const columns = [
    padLeft(String(st.ino), 8),
    padLeft(String(st.blocks), 6),
    formatMode(st.mode),
    padLeft(String(st.nlink), 3),
    padRight(owner, 8),
    padRight(group, 8),
    padLeft(String(st.size), 8),
    formatLsTime(st.mtimeMs, nowMs),
    name,
  ];
  return columns.join(' ') + NL;
}

/* -------------------------------------------------------------------------- */
/* Error reporting                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Record a non-fatal problem the way GNU find does: report it, raise the exit
 * status and keep going.
 */
export function reportError(
  state: InternalState,
  filePath: string,
  code: string,
  message: string,
): void {
  const info: FindErrorInfo = { path: filePath, code: code, message: message };
  state.errors.push(info);
  state.exitCode = 1;
  if (state.options.onError) {
    state.options.onError(info);
  }
}

/* -------------------------------------------------------------------------- */
/* Child process support for -exec / -execdir / -ok / -okdir                  */
/* -------------------------------------------------------------------------- */

/** Outcome of one external command invocation. */
export interface ExecOutcome {
  status: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/** A parsed -exec family predicate. */
export interface ExecSpec {
  /** Command words, possibly containing the '{}' placeholder. */
  template: string[];
  /** True for -execdir/-okdir. */
  execdir: boolean;
  /** True when the predicate ended with '+'. */
  batch: boolean;
  /** True for -ok/-okdir (ask before running). */
  interactive: boolean;
}

/** The placeholder replaced by the current path. */
export const EXEC_PLACEHOLDER = '{}';

/**
 * Recognise an -exec terminator.  Returns 'semicolon' for ';' (also written
 * ';'), 'plus' for '+', and null when the token is a regular command word.
 */
export function execTerminator(token: string): 'semicolon' | 'plus' | null {
  if (token === ';' || token === BS + ';') {
    return 'semicolon';
  }
  if (token === '+') {
    return 'plus';
  }
  return null;
}

/** Replace every '{}' inside one command word with VALUE. */
export function replacePlaceholder(word: string, value: string): string {
  if (word === EXEC_PLACEHOLDER) {
    return value;
  }
  if (word.indexOf(EXEC_PLACEHOLDER) !== -1) {
    return word.split(EXEC_PLACEHOLDER).join(value);
  }
  return word;
}

/** Start a child process and resolve when it exits. */
export function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
  capture: boolean,
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: cwd,
        windowsHide: true,
        stdio: capture
          ? ['ignore', 'pipe', 'pipe']
          : ['ignore', 'inherit', 'inherit'],
      });
    } catch (err) {
      resolve({ status: 1, stdout: '', stderr: '', error: String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    if (capture && child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
    }
    if (capture && child.stderr) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
    }
    child.on('error', (err: Error) => {
      resolve({ status: 1, stdout: stdout, stderr: stderr, error: err.message });
    });
    child.on('close', (code: number | null) => {
      resolve({ status: code === null ? 1 : code, stdout: stdout, stderr: stderr });
    });
  });
}

/**
 * Evaluate an -exec/-execdir/-ok/-okdir predicate for one entry.
 *
 * For the ';' form the command runs immediately and the predicate returns
 * true when the command exited with status 0.  For the '+' form the command
 * line is accumulated in state.execBatches and the predicate returns true at
 * once; the batches are run by {@link flushExecBatches}.
 */
export async function runExec(
  spec: ExecSpec,
  ctx: ExtendedContext,
): Promise<boolean> {
  const state = ctx.state;
  const options = ctx.options;

  if (spec.template.length === 0) {
    throw new FindError('-exec requires a command');
  }

  if (spec.interactive) {
    const promptText = spec.template.join(' ') + ' ' + ctx.path;
    let accepted = false;
    if (options.confirm) {
      accepted = await options.confirm(promptText);
    }
    if (!accepted) {
      return false;
    }
  }

  const target = spec.execdir ? './' + ctx.name : ctx.path;
  const cwd = spec.execdir ? dirNameOf(ctx.path) : process.cwd();

  if (spec.batch) {
    const prefix: string[] = [];
    for (let i = 0; i < spec.template.length; i++) {
      const word = spec.template[i];
      if (word === EXEC_PLACEHOLDER) {
        break;
      }
      prefix.push(replacePlaceholder(word, target));
    }
    if (prefix.length === 0) {
      throw new FindError('-exec requires a command');
    }

    let batch: ExecBatch | null = null;
    for (let i = 0; i < state.execBatches.length; i++) {
      const candidate = state.execBatches[i];
      if (candidate.dir !== cwd || candidate.execdir !== spec.execdir) {
        continue;
      }
      if (candidate.argv.length < prefix.length) {
        continue;
      }
      let same = true;
      for (let j = 0; j < prefix.length; j++) {
        if (candidate.argv[j] !== prefix[j]) {
          same = false;
          break;
        }
      }
      if (same) {
        batch = candidate;
        break;
      }
    }
    if (!batch) {
      batch = { argv: prefix.slice(), dir: cwd, execdir: spec.execdir };
      state.execBatches.push(batch);
    }
    batch.argv.push(target);
    return true;
  }

  const argv: string[] = [];
  for (let i = 0; i < spec.template.length; i++) {
    argv.push(replacePlaceholder(spec.template[i], target));
  }
  const command = argv[0];
  const args = argv.slice(1);
  const capture = options.execStdio === 'capture';

  const outcome = await spawnCommand(command, args, cwd, capture);
  if (capture) {
    if (outcome.stdout) {
      ctx.write(outcome.stdout);
    }
    if (outcome.stderr) {
      ctx.write(outcome.stderr);
    }
  }
  if (outcome.error) {
    reportError(state, ctx.path, 'EPATHEXEC', outcome.error);
    return false;
  }
  return outcome.status === 0;
}

/** Run every pending -exec ... + command line. */
export async function flushExecBatches(state: InternalState): Promise<void> {
  const batches = state.execBatches;
  state.execBatches = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    if (batch.argv.length === 0) {
      continue;
    }
    const command = batch.argv[0];
    const args = batch.argv.slice(1);
    const capture = state.options.execStdio === 'capture';
    const outcome = await spawnCommand(command, args, batch.dir, capture);
    if (capture) {
      if (outcome.stdout) {
        state.outputChunks.push(outcome.stdout);
      }
      if (outcome.stderr) {
        state.outputChunks.push(outcome.stderr);
      }
    }
    if (outcome.error) {
      reportError(state, batch.argv.join(' '), 'EPATHEXEC', outcome.error);
    } else if (outcome.status !== 0) {
      state.exitCode = 1;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Predicate nodes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A node of the compiled expression tree.  `evaluate` returns whether the
 * predicate (or sub-expression) is true for the current entry.
 */
export interface PredNode {
  /** Diagnostic name, e.g. '-name' or 'and'. */
  name: string;
  evaluate(ctx: EvalContext): Promise<boolean>;
}

/** Result of parsing an expression. */
export interface ParsedExpression {
  root: PredNode;
  /** True when the expression contains an action that suppresses -print. */
  noDefaultPrint: boolean;
  /** True when the expression contains any action at all. */
  hasAction: boolean;
}

const TRUE_NODE: PredNode = { name: 'true', evaluate: async () => true };
const FALSE_NODE: PredNode = { name: 'false', evaluate: async () => false };

/** Build an AND node with GNU's short-circuit behaviour. */
function makeAnd(left: PredNode, right: PredNode): PredNode {
  return {
    name: 'and',
    evaluate: async (ctx: EvalContext): Promise<boolean> => {
      const ok = await left.evaluate(ctx);
      if (!ok) {
        return false;
      }
      return right.evaluate(ctx);
    },
  };
}

/** Build an OR node with GNU's short-circuit behaviour. */
function makeOr(left: PredNode, right: PredNode): PredNode {
  return {
    name: 'or',
    evaluate: async (ctx: EvalContext): Promise<boolean> => {
      const ok = await left.evaluate(ctx);
      if (ok) {
        return true;
      }
      return right.evaluate(ctx);
    },
  };
}

/** Build a '!' node. */
function makeNot(inner: PredNode): PredNode {
  return {
    name: 'not',
    evaluate: async (ctx: EvalContext): Promise<boolean> => {
      const ok = await inner.evaluate(ctx);
      return !ok;
    },
  };
}

/**
 * Build a ',' node: both sides are evaluated for their side effects and only
 * the right hand side determines the truth value (GNU pred_comma).
 */
function makeComma(left: PredNode, right: PredNode): PredNode {
  return {
    name: 'comma',
    evaluate: async (ctx: EvalContext): Promise<boolean> => {
      await left.evaluate(ctx);
      return right.evaluate(ctx);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Regular expression translation                                            */
/* -------------------------------------------------------------------------- */

/**
 * Translate a POSIX Basic Regular Expression into the ECMAScript dialect.
 *
 * In a BRE the characters ( ) { } + ? | are literal and their escaped forms
 * become operators; ECMAScript is the opposite.  This is a character-level
 * translation, which is all -regextype posix-basic needs in practice.
 */
export function breToJs(pattern: string): string {
  let out = '';
  let i = 0;
  const operators = '(){}+?|';
  while (i < pattern.length) {
    const ch = pattern.charAt(i);
    if (ch === BS) {
      const next = pattern.charAt(i + 1);
      if (!next) {
        out += BS + BS;
        i++;
        continue;
      }
      if (operators.indexOf(next) !== -1) {
        out += next;
      } else {
        out += BS + next;
      }
      i += 2;
      continue;
    }
    if (operators.indexOf(ch) !== -1) {
      out += BS + ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Compile the argument of -regex/-iregex into an anchored RegExp.
 *
 * GNU requires the pattern to match the WHOLE path (pred_regex compares the
 * match length with the path length), hence the ^(?:...)$ wrapper.
 */
export function compilePathRegex(
  pattern: string,
  ignoreCase: boolean,
  regextype: string,
): RegExp {
  const body = regextype === 'posix-basic' ? breToJs(pattern) : pattern;
  try {
    return new RegExp('^(?:' + body + ')$', ignoreCase ? 'i' : '');
  } catch (err) {
    throw new FindError(
      'failed to compile regular expression ' + pattern + ': ' + String(err),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The expression parser                                                     */
/* -------------------------------------------------------------------------- */

const FILE_TYPE_CHARS = 'fdlbcpsD';

/** Return true when the token starts a new primary (used for implicit AND). */
function startsPrimaryToken(token: string): boolean {
  if (token === ')') {
    return false;
  }
  if (token === ',' || token === '-o' || token === '-or' || token === '-a' || token === '-and') {
    return false;
  }
  return true;
}

/** Read the stat of a reference file for -newer/-samefile at parse time. */
function referenceStat(fileName: string): fs.Stats {
  try {
    return fs.statSync(fileName);
  } catch (err) {
    throw new FindError(
      'cannot stat `' + fileName + "': " + String((err as Error).message || err),
    );
  }
}

/**
 * Recursive-descent parser for the find expression language.
 *
 * Grammar (highest precedence last):
 *
 *   expr   := and ( ',' and )*
 *   and    := or ( ( '-a' | '-and' )? or )*
 *   or     := unary ( ( '-o' | '-or' ) unary )*
 *   unary  := ( '!' | '-not' ) unary | primary
 *   primary:= '(' expr ')' | predicate
 */
export class ExpressionParser {
  private readonly tokens: string[];
  private pos: number;
  private readonly options: ResolvedOptions;
  noDefaultPrint: boolean;
  hasAction: boolean;

  constructor(tokens: string[], options: ResolvedOptions) {
    this.tokens = tokens;
    this.pos = 0;
    this.options = options;
    this.noDefaultPrint = false;
    this.hasAction = false;
  }

  /** Parse the whole token list. */
  parse(): PredNode {
    if (this.tokens.length === 0) {
      return TRUE_NODE;
    }
    const root = this.parseComma();
    if (this.pos < this.tokens.length) {
      throw new FindError(
        'paths must precede expression: `' + this.tokens[this.pos] + "'",
      );
    }
    return root;
  }

  /* --- cursor helpers ------------------------------------------------- */

  private peek(): string | undefined {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : undefined;
  }

  private advance(): string {
    if (this.pos >= this.tokens.length) {
      throw new FindError('unexpected end of expression');
    }
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private argument(what: string): string {
    if (this.pos >= this.tokens.length) {
      throw new FindError('missing argument to `' + what + "'");
    }
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  /* --- grammar -------------------------------------------------------- */

  private parseComma(): PredNode {
    let node = this.parseOr();
    while (this.peek() === ',') {
      this.advance();
      const right = this.parseOr();
      node = makeComma(node, right);
    }
    return node;
  }

  private parseOr(): PredNode {
    let node = this.parseAnd();
    let token = this.peek();
    while (token === '-o' || token === '-or') {
      this.advance();
      const right = this.parseAnd();
      node = makeOr(node, right);
      token = this.peek();
    }
    return node;
  }

  private parseAnd(): PredNode {
    let node = this.parseUnary();
    let token = this.peek();
    while (
      token !== undefined &&
      (token === '-a' || token === '-and' || startsPrimaryToken(token))
    ) {
      if (token === '-a' || token === '-and') {
        this.advance();
      }
      // Explicit '-a'/'-and', or an implicit AND between adjacent primaries.
      const right = this.parseUnary();
      node = makeAnd(node, right);
      token = this.peek();
    }
    return node;
  }

  private parseUnary(): PredNode {
    const token = this.peek();
    if (token === '!' || token === '-not') {
      this.advance();
      const inner = this.parseUnary();
      return makeNot(inner);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): PredNode {
    const token = this.peek();
    if (token === undefined) {
      throw new FindError('unexpected end of expression');
    }
    if (token === '(') {
      this.advance();
      const inner = this.parseComma();
      const close = this.peek();
      if (close !== ')') {
        throw new FindError('missing closing parenthesis');
      }
      this.advance();
      return inner;
    }
    if (token === ')') {
      throw new FindError('unexpected closing parenthesis');
    }
    this.advance();
    return this.buildPredicate(token);
  }

  /* --- predicate builders --------------------------------------------- */

  private buildPredicate(token: string): PredNode {
    const options = this.options;

    switch (token) {
      /* ---- name and path tests ------------------------------------- */
      case '-name':
      case '-iname': {
        const pattern = this.argument(token);
        const ignoreCase = token === '-iname';
        const mode = options.nameMatchMode;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            matchesNamePattern(ctx.name, pattern, mode, ignoreCase),
        };
      }
      case '-path':
      case '-wholename':
      case '-ipath':
      case '-iwholename': {
        const pattern = this.argument(token);
        const ignoreCase = token === '-ipath' || token === '-iwholename';
        const mode = options.nameMatchMode;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            matchesNamePattern(ctx.path, pattern, mode, ignoreCase),
        };
      }
      case '-lname':
      case '-ilname': {
        const pattern = this.argument(token);
        const ignoreCase = token === '-ilname';
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            if (!ctx.linkTarget) {
              return false;
            }
            return globToRegExp(pattern, ignoreCase).test(ctx.linkTarget);
          },
        };
      }
      case '-regex':
      case '-iregex': {
        const pattern = this.argument(token);
        const re = compilePathRegex(pattern, token === '-iregex', options.regextype);
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => re.test(ctx.path),
        };
      }

      /* ---- file type ----------------------------------------------- */
      case '-type':
      case '-xtype': {
        const spec = this.argument(token);
        const wanted: { [ch: string]: boolean } = {};
        const parts = spec.split(',');
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i].trim();
          if (part.length === 0) {
            continue;
          }
          if (part.length !== 1 || FILE_TYPE_CHARS.indexOf(part) === -1) {
            throw new FindError('Unknown file type `' + part + "'");
          }
          wanted[part] = true;
        }
        const useTarget = token === '-xtype';
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            const actual = useTarget
              ? (ctx as ExtendedContext).targetType || 'N'
              : ctx.stat.fileType;
            return wanted[actual] === true;
          },
        };
      }

      /* ---- numeric attribute tests --------------------------------- */
      case '-size': {
        const sizeSpec = parseSizeSpec(this.argument(token));
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            sizeMatches(sizeSpec, ctx.stat.size),
        };
      }
      case '-perm': {
        const permSpec = parsePermSpec(this.argument(token));
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            permMatches(permSpec, ctx.stat.mode),
        };
      }
      case '-user': {
        const wantUid = resolveUid(this.argument(token));
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => ctx.stat.uid === wantUid,
        };
      }
      case '-group': {
        const wantGid = resolveGid(this.argument(token));
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => ctx.stat.gid === wantGid,
        };
      }
      case '-uid': {
        const uidSpec = parseNumberSpec(this.argument(token), '-uid');
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            compareNumber(uidSpec.cmp, ctx.stat.uid, uidSpec.value),
        };
      }
      case '-gid': {
        const gidSpec = parseNumberSpec(this.argument(token), '-gid');
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            compareNumber(gidSpec.cmp, ctx.stat.gid, gidSpec.value),
        };
      }
      case '-links': {
        const linksSpec = parseNumberSpec(this.argument(token), '-links');
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            compareNumber(linksSpec.cmp, ctx.stat.nlink, linksSpec.value),
        };
      }
      case '-inum': {
        const inumSpec = parseNumberSpec(this.argument(token), '-inum');
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            compareNumber(inumSpec.cmp, ctx.stat.ino, inumSpec.value),
        };
      }

      /* ---- access / emptiness -------------------------------------- */
      case '-empty': {
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            if (ctx.stat.isDirectory) {
              try {
                const names = await fs.promises.readdir(ctx.path);
                return names.length === 0;
              } catch (err) {
                reportError(
                  ctx.state,
                  ctx.path,
                  'EREADDIR',
                  String((err as Error).message || err),
                );
                return false;
              }
            }
            if (ctx.stat.isFile) {
              return ctx.stat.size === 0;
            }
            return false;
          },
        };
      }
      case '-readable':
      case '-writable':
      case '-executable': {
        const mode =
          token === '-readable'
            ? fs.constants.R_OK
            : token === '-writable'
              ? fs.constants.W_OK
              : fs.constants.X_OK;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            try {
              await fs.promises.access(ctx.path, mode);
              return true;
            } catch (err) {
              return false;
            }
          },
        };
      }

      /* ---- time tests ---------------------------------------------- */
      case '-mtime':
      case '-atime':
      case '-ctime': {
        const spec = parseTimeSpec(
          this.argument(token),
          DAY_SECONDS,
          options.curDayStartMs,
          true,
        );
        return this.buildTimePredicate(token, spec);
      }
      case '-mmin':
      case '-amin':
      case '-cmin': {
        const spec = parseTimeSpec(
          this.argument(token),
          MINUTE_SECONDS,
          options.startTimeMs,
          false,
        );
        return this.buildTimePredicate(token, spec);
      }
      case '-newer':
      case '-anewer':
      case '-cnewer': {
        const refName = this.argument(token);
        const refStat = referenceStat(refName);
        const refMs =
          token === '-anewer'
            ? refStat.atimeMs
            : token === '-cnewer'
              ? refStat.ctimeMs
              : refStat.mtimeMs;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            const value =
              token === '-anewer'
                ? ctx.stat.atimeMs
                : token === '-cnewer'
                  ? ctx.stat.ctimeMs
                  : ctx.stat.mtimeMs;
            return value > refMs;
          },
        };
      }
      case '-samefile': {
        const refName = this.argument(token);
        const refStat = referenceStat(refName);
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            ctx.stat.dev === refStat.dev && ctx.stat.ino === refStat.ino,
        };
      }

      /* ---- boolean constants and control flow ---------------------- */
      case '-true':
        return TRUE_NODE;
      case '-false':
        return FALSE_NODE;
      case '-prune':
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            if (!ctx.options.depth && ctx.stat.isDirectory) {
              ctx.prune();
            }
            return true;
          },
        };
      case '-quit':
        this.hasAction = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            ctx.requestQuit();
            return true;
          },
        };

      /* ---- actions ------------------------------------------------ */
      case '-print':
        this.hasAction = true;
        this.noDefaultPrint = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            ctx.write(ctx.path + NL);
            return true;
          },
        };
      case '-print0':
        this.hasAction = true;
        this.noDefaultPrint = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            ctx.write(ctx.path + NUL);
            return true;
          },
        };
      case '-printf': {
        const format = this.argument(token);
        this.hasAction = true;
        this.noDefaultPrint = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            ctx.write(formatPrintf(format, ctx as ExtendedContext));
            return true;
          },
        };
      }
      case '-ls':
        this.hasAction = true;
        this.noDefaultPrint = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            ctx.write(formatLsLine(ctx, ctx.options.startTimeMs));
            return true;
          },
        };
      case '-fprint':
      case '-fprint0': {
        const target = this.argument(token);
        const terminator = token === '-fprint0' ? NUL : NL;
        this.hasAction = true;
        this.noDefaultPrint = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            try {
              await fs.promises.appendFile(target, ctx.path + terminator);
              return true;
            } catch (err) {
              reportError(
                ctx.state,
                ctx.path,
                'EWRITE',
                String((err as Error).message || err),
              );
              return false;
            }
          },
        };
      }
      case '-fprintf': {
        const target = this.argument(token);
        const format = this.argument(token);
        this.hasAction = true;
        this.noDefaultPrint = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => {
            try {
              await fs.promises.appendFile(
                target,
                formatPrintf(format, ctx as ExtendedContext),
              );
              return true;
            } catch (err) {
              reportError(
                ctx.state,
                ctx.path,
                'EWRITE',
                String((err as Error).message || err),
              );
              return false;
            }
          },
        };
      }
      case '-delete': {
        this.hasAction = true;
        this.noDefaultPrint = true;
        // GNU: -delete implies -depth.
        options.depth = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> => ctx.remove(),
        };
      }
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir': {
        const collected = this.collectExecWords(token);
        this.hasAction = true;
        this.noDefaultPrint = true;
        return {
          name: token,
          evaluate: async (ctx: EvalContext): Promise<boolean> =>
            runExec(collected, ctx as ExtendedContext),
        };
      }

      /* ---- global options (consumed during parsing) ---------------- */
      case '-maxdepth': {
        options.maxdepth = parseUintArg(this.argument(token), '-maxdepth');
        return TRUE_NODE;
      }
      case '-mindepth': {
        options.mindepth = parseUintArg(this.argument(token), '-mindepth');
        return TRUE_NODE;
      }
      case '-depth':
      case '-d':
        options.depth = true;
        options.explicitDepth = true;
        return TRUE_NODE;
      case '-follow':
        options.symlink = 'L';
        return TRUE_NODE;
      case '-L':
        options.symlink = 'L';
        return TRUE_NODE;
      case '-H':
        options.symlink = 'H';
        return TRUE_NODE;
      case '-P':
        options.symlink = 'P';
        return TRUE_NODE;
      case '-xdev':
      case '-mount':
        options.xdev = true;
        return TRUE_NODE;
      case '-daystart':
        options.daystart = true;
        options.curDayStartMs = startOfToday(options.startTimeMs);
        return TRUE_NODE;
      case '-regextype':
        options.regextype = this.argument(token);
        return TRUE_NODE;
      case '-ignore_readdir_race':
        options.ignoreReaddirRace = true;
        return TRUE_NODE;
      case '-noleaf':
      case '-warn':
      case '-nowarn':
      case '-nouser':
        return TRUE_NODE;
      case '-nogrp':
        return TRUE_NODE;

      default:
        break;
    }

    // -newerXY family: -newermt, -newerat, -newercm, ... (8 characters).
    if (token.length === 8 && token.indexOf('-newer') === 0) {
      return this.buildNewerXY(token);
    }

    throw new FindError('unknown predicate `' + token + "'");
  }

  /** Build a -mtime/-mmin style predicate for the given reference time. */
  private buildTimePredicate(token: string, spec: TimeSpec): PredNode {
    return {
      name: token,
      evaluate: async (ctx: EvalContext): Promise<boolean> => {
        let valueMs: number;
        if (token === '-atime' || token === '-amin') {
          valueMs = ctx.stat.atimeMs;
        } else if (token === '-ctime' || token === '-cmin') {
          valueMs = ctx.stat.ctimeMs;
        } else {
          valueMs = ctx.stat.mtimeMs;
        }
        return timeWindowMatches(valueMs, spec);
      },
    };
  }

  /**
   * Build one of the -newerXY primaries.  X selects which timestamp of the
   * entry is compared (a, B, c, m) and Y selects the reference: 't' for a
   * date string, otherwise another timestamp of a reference file.
   */
  private buildNewerXY(token: string): PredNode {
    const x = token.charAt(6);
    const y = token.charAt(7);
    const arg = this.argument(token);

    let referenceMs: number;
    if (y === 't') {
      const parsed = Date.parse(arg);
      if (isNaN(parsed)) {
        throw new FindError('invalid date `' + arg + "' for " + token);
      }
      referenceMs = parsed;
    } else if (y === 'a' || y === 'B' || y === 'c' || y === 'm') {
      const refStat = referenceStat(arg);
      referenceMs =
        y === 'a'
          ? refStat.atimeMs
          : y === 'c'
            ? refStat.ctimeMs
            : y === 'm'
              ? refStat.mtimeMs
              : refStat.birthtimeMs;
    } else {
      throw new FindError('unknown predicate `' + token + "'");
    }

    return {
      name: token,
      evaluate: async (ctx: EvalContext): Promise<boolean> => {
        const valueMs =
          x === 'a'
            ? ctx.stat.atimeMs
            : x === 'c'
              ? ctx.stat.ctimeMs
              : x === 'B'
                ? ctx.stat.birthtimeMs
                : ctx.stat.mtimeMs;
        return valueMs > referenceMs;
      },
    };
  }

  /** Collect the command words of -exec/-execdir/-ok/-okdir up to its terminator. */
  private collectExecWords(token: string): ExecSpec {
    const template: string[] = [];
    let terminator: 'semicolon' | 'plus' | null = null;
    let scanning = true;
    while (scanning) {
      const next = this.peek();
      if (next === undefined) {
        throw new FindError('missing argument to `' + token + "'");
      }
      this.advance();
      const term = execTerminator(next);
      if (term) {
        terminator = term;
        scanning = false;
      } else {
        template.push(next);
      }
    }
    if (template.length === 0) {
      throw new FindError('missing argument to `' + token + "'");
    }
    return {
      template: template,
      execdir: token === '-execdir' || token === '-okdir',
      batch: terminator === 'plus',
      interactive: token === '-ok' || token === '-okdir',
    };
  }
}

/** Compile an argv style expression into a predicate tree. */
export function parseExpression(
  tokens: string[],
  options: ResolvedOptions,
): ParsedExpression {
  const parser = new ExpressionParser(tokens, options);
  const root = parser.parse();
  return {
    root: root,
    noDefaultPrint: parser.noDefaultPrint,
    hasAction: parser.hasAction,
  };
}

/* -------------------------------------------------------------------------- */
/* Directory reading                                                         */
/* -------------------------------------------------------------------------- */

/** One directory entry as produced by readDirNames(). */
export interface DirEntryName {
  name: string;
  /** Dirent type information, when the platform provides it. */
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
}

/**
 * Read a directory, preferring readdir(withFileTypes) and falling back to the
 * plain form when the runtime or file system cannot supply types.
 */
async function readDirNames(dir: string): Promise<DirEntryName[]> {
  const result: DirEntryName[] = [];
  const withTypes = fs.promises.readdir as unknown as (
    p: string,
    opts: { withFileTypes: boolean },
  ) => Promise<Array<fs.Dirent | string>>;

  try {
    const entries = await withTypes(dir, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (typeof entry === 'string') {
        result.push({ name: entry });
        continue;
      }
      result.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      });
    }
    return result;
  } catch (err) {
    // Fall through to the plain readdir() form.
  }

  const names = await fs.promises.readdir(dir);
  for (let i = 0; i < names.length; i++) {
    result.push({ name: String(names[i]) });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Entry construction                                                        */
/* -------------------------------------------------------------------------- */

/** Join a directory and a name using the platform separator. */
function joinPath(dir: string, name: string): string {
  if (dir === '') {
    return name;
  }
  if (dir.charAt(dir.length - 1) === path.sep) {
    return dir + name;
  }
  return dir + path.sep + name;
}

/** True when the error means "the link target does not exist". */
function isDanglingLinkError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR';
}

/** Read a symlink target, returning undefined when it cannot be read. */
async function readLinkTarget(filePath: string): Promise<string | undefined> {
  try {
    const value = await fs.promises.readlink(filePath);
    return typeof value === 'string' ? value : undefined;
  } catch (err) {
    return undefined;
  }
}

/**
 * Build a FindEntry for one path, honouring the configured symlink mode.
 *
 * -P (default): lstat(), so a symlink is reported as a symlink.
 * -L          : stat(), following links; a dangling link falls back to lstat.
 * -H          : stat() for command line starting points and lstat() below.
 */
export async function statEntry(
  filePath: string,
  depth: number,
  startPath: string,
  options: ResolvedOptions,
  isStart: boolean,
  linkTargetHint?: string,
): Promise<FindEntry | null> {
  const follow =
    options.symlink === 'L' || (options.symlink === 'H' && isStart);

  let raw: fs.Stats | null = null;
  if (follow) {
    try {
      raw = await fs.promises.stat(filePath);
    } catch (err) {
      if (!isDanglingLinkError(err)) {
        throw err;
      }
      // Dangling link under -L/-H: fall back to the link itself.
      raw = null;
    }
  }
  if (!raw) {
    raw = await fs.promises.lstat(filePath);
  }

  const stat = normalizeStat(raw);
  const name = path.basename(filePath);
  let relative = '';
  if (depth > 0) {
    const startWithSep =
      startPath.charAt(startPath.length - 1) === path.sep ? startPath : startPath + path.sep;
    relative =
      filePath.indexOf(startWithSep) === 0
        ? filePath.slice(startWithSep.length)
        : filePath;
  }

  let linkTarget: string | undefined = undefined;
  if (stat.isSymbolicLink) {
    linkTarget =
      linkTargetHint !== undefined
        ? linkTargetHint
        : await readLinkTarget(filePath);
  }

  return {
    path: filePath,
    name: name,
    depth: depth,
    startPath: startPath,
    relativePath: relative,
    stat: stat,
    linkTarget: linkTarget,
    isStart: isStart,
  };
}

/** Determine the file type of a symlink target, for %Y / -xtype. */
async function targetFileType(entry: FindEntry): Promise<FileTypeChar> {
  if (!entry.stat.isSymbolicLink) {
    return entry.stat.fileType;
  }
  try {
    const st = await fs.promises.stat(entry.path);
    return statFileType(st.mode);
  } catch (err) {
    return 'N' as FileTypeChar;
  }
}

/* -------------------------------------------------------------------------- */
/* The evaluation context                                                    */
/* -------------------------------------------------------------------------- */

/** Concrete EvalContext handed to the compiled expression. */
class Context implements ExtendedContext {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly stat: FindStat;
  readonly isStart: boolean;
  readonly startPath: string;
  readonly relativePath: string;
  readonly linkTarget?: string;
  readonly options: ResolvedOptions;
  readonly state: InternalState;
  targetType?: FileTypeChar;
  fsType?: string;

  constructor(entry: FindEntry, state: InternalState) {
    this.path = entry.path;
    this.name = entry.name;
    this.depth = entry.depth;
    this.stat = entry.stat;
    this.isStart = entry.isStart;
    this.startPath = entry.startPath;
    this.relativePath = entry.relativePath;
    this.linkTarget = entry.linkTarget;
    this.options = state.options;
    this.state = state;
  }

  prune(): void {
    this.state.stopAtCurrentLevel = true;
  }

  requestQuit(): void {
    this.state.quit = true;
  }

  write(text: string): void {
    if (!text) {
      return;
    }
    this.state.outputChunks.push(text);
    if (this.state.options.onOutput) {
      this.state.options.onOutput(text);
    }
  }

  async remove(): Promise<boolean> {
    const state = this.state;
    try {
      if (this.stat.isDirectory) {
        await fs.promises.rmdir(this.path);
      } else {
        await fs.promises.unlink(this.path);
      }
      state.deleted.push(this.path);
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' && state.options.ignoreReaddirRace) {
        return true;
      }
      reportError(
        state,
        this.path,
        'EDELETE',
        'cannot delete ' + this.path + ': ' + String((err as Error).message || err),
      );
      return false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The walker                                                                */
/* -------------------------------------------------------------------------- */

/** State carried through the recursion. */
interface WalkState {
  /** 'dev:ino' keys of the directories currently on the stack. */
  ancestors: { [key: string]: boolean };
  /** Device of the starting point, for -xdev. */
  startDev: number;
  /** Root device captured from the first starting point. */
  haveStartDev: boolean;
}

/**
 * Recursively walk one starting point, evaluating the expression for every
 * entry.
 */
async function walk(
  filePath: string,
  depth: number,
  startPath: string,
  isStart: boolean,
  expression: PredNode,
  defaultPrint: boolean,
  state: InternalState,
  walkState: WalkState,
): Promise<void> {
  const options = state.options;

  if (state.quit) {
    return;
  }
  if (options.signal && options.signal.aborted) {
    state.quit = true;
    return;
  }
  if (options.maxResults > 0 && state.entries.length >= options.maxResults) {
    state.quit = true;
    return;
  }

  let entry: FindEntry | null;
  try {
    entry = await statEntry(filePath, depth, startPath, options, isStart);
  } catch (err) {
    const code = (err as { code?: string }).code || 'ESTAT';
    if (!(code === 'ENOENT' && options.ignoreReaddirRace)) {
      reportError(
        state,
        filePath,
        code,
        "cannot stat '" + filePath + "': " + String((err as Error).message || err),
      );
    }
    return;
  }
  if (!entry) {
    return;
  }

  state.visited++;

  if (!walkState.haveStartDev) {
    walkState.startDev = entry.stat.dev;
    walkState.haveStartDev = true;
  }

  const ctx = new Context(entry, state);
  ctx.targetType = await targetFileType(entry);

  // The entry is tested only when it is at or below -mindepth.
  const passesMindepth = depth >= options.mindepth;

  const descendInto =
    entry.stat.isDirectory &&
    (options.maxdepth < 0 || depth < options.maxdepth) &&
    !(options.xdev && entry.stat.dev !== walkState.startDev);

  const isAncestorKey = entry.stat.dev + ':' + entry.stat.ino;
  let canDescend = descendInto;
  if (canDescend && walkState.ancestors[isAncestorKey]) {
    // Cycle: do not descend again.
    canDescend = false;
  }

  // ---- pre-order phase --------------------------------------------------
  if (!options.depth) {
    state.stopAtCurrentLevel = false;
    if (passesMindepth) {
      let matched: boolean;
      try {
        matched = await expression.evaluate(ctx);
      } catch (err) {
        reportError(
          state,
          entry.path,
          'EEVAL',
          String((err as Error).message || err),
        );
        matched = false;
      }
      if (matched) {
        if (defaultPrint) {
          ctx.write(entry.path + NL);
        }
        recordMatch(state, entry);
      }
    }
    if (state.stopAtCurrentLevel) {
      canDescend = false;
    }
  }

  if (state.quit) {
    return;
  }

  // ---- recursion --------------------------------------------------------
  if (canDescend) {
    walkState.ancestors[isAncestorKey] = true;
    let children: DirEntryName[] = [];
    try {
      children = await readDirNames(entry.path);
    } catch (err) {
      const code = (err as { code?: string }).code || 'EREADDIR';
      if (!(code === 'ENOENT' && options.ignoreReaddirRace)) {
        reportError(
          state,
          entry.path,
          code,
          "cannot read directory '" + entry.path + "': " +
            String((err as Error).message || err),
        );
      }
      children = [];
    }

    for (let i = 0; i < children.length; i++) {
      if (state.quit) {
        break;
      }
      const child = children[i];
      const childPath = joinPath(entry.path, child.name);
      await walk(
        childPath,
        depth + 1,
        startPath,
        false,
        expression,
        defaultPrint,
        state,
        walkState,
      );
    }

    delete walkState.ancestors[isAncestorKey];
  }

  if (state.quit) {
    return;
  }

  // ---- post-order phase (-depth) ----------------------------------------
  if (options.depth && passesMindepth) {
    state.stopAtCurrentLevel = false;
    let matched: boolean;
    try {
      matched = await expression.evaluate(ctx);
    } catch (err) {
      reportError(
        state,
        entry.path,
        'EEVAL',
        String((err as Error).message || err),
      );
      matched = false;
    }
    if (matched) {
      if (defaultPrint) {
        ctx.write(entry.path + NL);
      }
      recordMatch(state, entry);
    }
  }
}

/** Store a matching entry and notify the caller. */
function recordMatch(state: InternalState, entry: FindEntry): void {
  state.entries.push(entry);
  if (state.options.onMatch) {
    state.options.onMatch(entry);
  }
}

/* -------------------------------------------------------------------------- */
/* Option normalisation                                                      */
/* -------------------------------------------------------------------------- */

/** Apply defaults to a FindOptions bag, producing the internal shape. */
export function resolveOptions(input?: FindOptions): ResolvedOptions {
  const opts: FindOptions = input || {};
  const now = Date.now();

  let paths: string[] = ['.'];
  if (opts.paths) {
    paths = Array.isArray(opts.paths) ? opts.paths.slice() : [opts.paths];
  }
  if (paths.length === 0) {
    paths = ['.'];
  }

  let symlink: SymlinkMode = 'P';
  if (opts.follow) {
    symlink = 'L';
  }
  if (opts.symlink) {
    symlink = opts.symlink;
  }

  const daystart = opts.daystart === true;

  return {
    paths: paths,
    maxdepth: opts.maxdepth === undefined ? -1 : opts.maxdepth,
    mindepth: opts.mindepth === undefined ? 0 : opts.mindepth,
    depth: opts.depth === true,
    explicitDepth: opts.depth === true,
    symlink: symlink,
    xdev: opts.xdev === true,
    daystart: daystart,
    ignoreReaddirRace: opts.ignoreReaddirRace === true,
    nameMatchMode: opts.nameMatchMode || 'auto',
    regextype: opts.regextype || 'findutils-default',
    startTimeMs: now,
    curDayStartMs: daystart ? startOfToday(now) : now - DAY_SECONDS * 1000,
    outputBlockSize: 1024,
    maxResults: opts.maxResults === undefined ? 0 : opts.maxResults,
    execStdio: opts.execStdio || 'inherit',
    signal: opts.signal,
    onError: opts.onError,
    onOutput: opts.onOutput,
    onMatch: opts.onMatch,
    confirm: opts.confirm,
  };
}

/* -------------------------------------------------------------------------- */
/* Option -> argv conversion                                                 */
/* -------------------------------------------------------------------------- */

/** Append a value as one argv token. */
function pushToken(argv: string[], token: string): void {
  argv.push(token);
}

/** Append `-test value` when the value is defined. */
function pushTest(argv: string[], test: string, value: string | number | undefined): void {
  if (value === undefined) {
    return;
  }
  argv.push(test);
  argv.push(String(value));
}

/** Append `-test value` once for every value in a string-or-array field. */
function pushTestMany(
  argv: string[],
  test: string,
  value: string | string[] | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  for (let i = 0; i < values.length; i++) {
    argv.push(test);
    argv.push(values[i]);
  }
}

/** Append the action tokens implied by the semantic options. */
function pushActions(argv: string[], opts: FindOptions): void {
  if (opts.print) {
    pushToken(argv, '-print');
  }
  if (opts.print0) {
    pushToken(argv, '-print0');
  }
  if (opts.printf !== undefined) {
    argv.push('-printf');
    argv.push(opts.printf);
  }
  if (opts.ls) {
    pushToken(argv, '-ls');
  }
  if (opts.delete) {
    pushToken(argv, '-delete');
  }
  const execList = opts.exec;
  if (execList !== undefined) {
    const words = Array.isArray(execList) ? execList : [execList];
    argv.push('-exec');
    for (let i = 0; i < words.length; i++) {
      argv.push(words[i]);
    }
    argv.push(';');
  }
  const execdirList = opts.execdir;
  if (execdirList !== undefined) {
    const words = Array.isArray(execdirList) ? execdirList : [execdirList];
    argv.push('-execdir');
    for (let i = 0; i < words.length; i++) {
      argv.push(words[i]);
    }
    argv.push(';');
  }
  if (opts.quitOnFirstMatch) {
    pushToken(argv, '-quit');
  }
}

/**
 * Translate the convenient FindOptions fields into GNU style argv tokens.
 * These tests are emitted before the user supplied expression, so both are
 * ANDed together just like writing them on one command line.
 */
export function optionsToArgv(opts: FindOptions): string[] {
  const argv: string[] = [];

  pushTestMany(argv, '-name', opts.name);
  pushTestMany(argv, '-iname', opts.iname);
  pushTestMany(argv, '-path', opts.path);
  pushTestMany(argv, '-ipath', opts.ipath);
  if (opts.regex !== undefined) {
    argv.push('-regex');
    argv.push(opts.regex instanceof RegExp ? opts.regex.source : String(opts.regex));
  }
  if (opts.iregex !== undefined) {
    argv.push('-iregex');
    argv.push(opts.iregex instanceof RegExp ? opts.iregex.source : String(opts.iregex));
  }

  pushTest(argv, '-type', opts.type);
  pushTest(argv, '-xtype', opts.xtype);
  pushTest(argv, '-size', opts.size);
  pushTest(argv, '-perm', opts.perm);
  pushTest(argv, '-user', opts.user);
  pushTest(argv, '-group', opts.group);
  pushTest(argv, '-uid', opts.uid);
  pushTest(argv, '-gid', opts.gid);
  pushTest(argv, '-links', opts.links);
  pushTest(argv, '-inum', opts.inum);

  if (opts.empty) {
    pushToken(argv, '-empty');
  }
  if (opts.readable) {
    pushToken(argv, '-readable');
  }
  if (opts.writable) {
    pushToken(argv, '-writable');
  }
  if (opts.executable) {
    pushToken(argv, '-executable');
  }

  pushTest(argv, '-mtime', opts.mtime);
  pushTest(argv, '-mmin', opts.mmin);
  pushTest(argv, '-atime', opts.atime);
  pushTest(argv, '-amin', opts.amin);
  pushTest(argv, '-ctime', opts.ctime);
  pushTest(argv, '-cmin', opts.cmin);

  if (opts.newer !== undefined) {
    argv.push('-newer');
    argv.push(opts.newer instanceof Date ? opts.newer.toISOString() : String(opts.newer));
  }
  if (opts.anewer !== undefined) {
    argv.push('-anewer');
    argv.push(opts.anewer instanceof Date ? opts.anewer.toISOString() : String(opts.anewer));
  }
  if (opts.cnewer !== undefined) {
    argv.push('-cnewer');
    argv.push(opts.cnewer instanceof Date ? opts.cnewer.toISOString() : String(opts.cnewer));
  }
  if (opts.newermt !== undefined) {
    argv.push('-newermt');
    argv.push(opts.newermt instanceof Date ? opts.newermt.toISOString() : String(opts.newermt));
  }

  pushActions(argv, opts);
  return argv;
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                    */
/* -------------------------------------------------------------------------- */

/** Create an empty InternalState for one run. */
function createState(options: ResolvedOptions): InternalState {
  return {
    options: options,
    outputChunks: [],
    entries: [],
    errors: [],
    deleted: [],
    exitCode: 0,
    quit: false,
    stopAtCurrentLevel: false,
    visited: 0,
    uid: currentUserId(),
    username: currentUserName(),
    execBatches: [],
  };
}

/**
 * Run a find expression over a set of starting points.
 *
 * @param paths   Starting points (a single path or an array).
 * @param tokens  GNU style expression tokens.
 * @param options Runtime options (callbacks, safety limits, ...).
 */
export async function runFind(
  paths: string[],
  tokens: string[],
  options?: FindOptions,
): Promise<FindResult> {
  const opts = resolveOptions(options);
  if (paths && paths.length > 0) {
    opts.paths = paths.slice();
  }

  // Global options are parsed first so they apply to the whole traversal.
  const parsed = parseExpression(tokens, opts);
  const state = createState(opts);

  // GNU find prints by default only when no action was supplied at all.
  const defaultPrint = !parsed.noDefaultPrint;

  const walkState: WalkState = {
    ancestors: {},
    startDev: 0,
    haveStartDev: false,
  };

  for (let i = 0; i < opts.paths.length; i++) {
    if (state.quit) {
      break;
    }
    const startPath = opts.paths[i];
    walkState.haveStartDev = false;
    walkState.ancestors = {};
    await walk(
      startPath,
      0,
      startPath,
      true,
      parsed.root,
      defaultPrint,
      state,
      walkState,
    );
  }

  await flushExecBatches(state);

  return {
    entries: state.entries,
    output: state.outputChunks.join(''),
    errors: state.errors,
    deleted: state.deleted,
    exitCode: state.exitCode,
    stopped: state.quit,
    visited: state.visited,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run GNU style find arguments.
 *
 * Starting points are the leading non-option arguments, like the real find:
 *
 *     await find(['.', '-name', 'abc', '-type', 'f']);
 *     await find(['src', 'test', '-name', '*.ts']);
 *
 * A path may be omitted, in which case the expression is evaluated over '.'.
 */
export async function find(argv: string[], options?: FindOptions): Promise<FindResult> {
  const paths: string[] = [];
  const tokens: string[] = [];

  let i = 0;
  // Leading arguments that do not look like a test/option are paths.  A token
  // beginning with '-' is an expression token; '(' and '!' also start the
  // expression.
  while (i < argv.length) {
    const token = argv[i];
    if (token === '(' || token === '!' || token === ')') {
      break;
    }
    if (token.length > 0 && token.charAt(0) === '-') {
      break;
    }
    paths.push(token);
    i++;
  }
  while (i < argv.length) {
    tokens.push(argv[i]);
    i++;
  }

  if (paths.length === 0) {
    paths.push('.');
  }
  // Strip a run of leading dash-less tokens that are actually the expression
  // tail when the caller passed paths inside the expression by mistake.
  return runFind(paths, tokens, options);
}

/**
 * Find entries using the semantic option bag only -- no raw expression.
 *
 * This is the most convenient entry point:
 *
 *     const result = await findFiles({
 *       paths: ['src'],
 *       name: 'abc',
 *       type: 'f',
 *       maxdepth: 4,
 *     });
 */
export async function findFiles(options?: FindOptions): Promise<FindResult> {
  const opts: FindOptions = options || {};
  const paths: string[] = opts.paths
    ? Array.isArray(opts.paths)
      ? opts.paths.slice()
      : [opts.paths]
    : ['.'];

  const tokens: string[] = [];
  const shorthand = optionsToArgv(opts);
  for (let i = 0; i < shorthand.length; i++) {
    tokens.push(shorthand[i]);
  }
  if (opts.expression) {
    for (let i = 0; i < opts.expression.length; i++) {
      tokens.push(opts.expression[i]);
    }
  }

  return runFind(paths.length > 0 ? paths : ['.'], tokens, opts);
}

/**
 * Find files whose NAME contains the given text (or matches it as a glob).
 *
 * A bare word is a substring match, so searching 'abc' returns
 * './1111abc11111.java' -- exactly the behaviour the caller usually wants.
 * Extra options are merged, so filters may be added freely:
 *
 *     await findFilesByName('src', 'abc', { type: 'f' });
 */
export async function findFilesByName(
  root: string,
  name: string,
  extra?: FindOptions,
): Promise<FindResult> {
  const opts: FindOptions = extra ? Object.assign({}, extra) : {};
  opts.paths = root !== undefined && root !== null && root !== '' ? root : '.';
  if (opts.name === undefined) {
    opts.name = name;
  }
  return findFiles(opts);
}

/**
 * Find files whose full path matches a regular expression.
 *
 * The pattern is anchored like GNU -regex, so '.*[.]java$' selects every
 * Java file while 'a.*b' requires a path that starts with 'a' and ends with
 * 'b'.  Pass a RegExp to control the flags yourself.
 */
export async function findFilesRegex(
  root: string,
  pattern: string | RegExp,
  extra?: FindOptions,
): Promise<FindResult> {
  const opts: FindOptions = extra ? Object.assign({}, extra) : {};
  opts.paths = root !== undefined && root !== null && root !== '' ? root : '.';
  if (pattern instanceof RegExp) {
    if (pattern.ignoreCase) {
      opts.iregex = pattern.source;
    } else {
      opts.regex = pattern.source;
    }
  } else {
    opts.regex = String(pattern);
  }
  return findFiles(opts);
}

/**
 * Convenience wrapper returning just the matching paths.
 */
export async function findPaths(
  argv: string[],
  options?: FindOptions,
): Promise<string[]> {
  const result = await find(argv, options);
  const paths: string[] = [];
  for (let i = 0; i < result.entries.length; i++) {
    paths.push(result.entries[i].path);
  }
  return paths;
}

/* -------------------------------------------------------------------------- */
/* Module summary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Supported GNU find surface
 * ------------------------------------------------------------------------
 * Operators      ( )  ! -not  -a -and  -o -or  ,   (precedence: , < -o < -a < !)
 * Name/path      -name -iname -path -wholename -ipath -iwholename -lname
 *                -ilname -regex -iregex  (name matching: substring or glob)
 * Type           -type -xtype   (f d l b c p s D, comma separated)
 * Size           -size  (b c w k M G suffixes, rounded up)
 * Permissions    -perm  (octal / symbolic, exact, '-mode', '/mode')
 * Owner          -user -group -uid -gid -nouser -nogrp
 * Numeric        -links -inum
 * Content        -empty -readable -writable -executable
 * Time           -mtime -mmin -atime -amin -ctime -cmin
 *                -newer -anewer -cnewer -newerXY (e.g. -newermt)
 * Identity       -samefile
 * Control        -true -false -prune -quit -depth -d -maxdepth -mindepth
 *                -follow -L -H -P -xdev -mount -daystart -regextype
 *                -ignore_readdir_race -noleaf -warn -nowarn
 * Actions        -print -print0 -printf -ls -fls -fprint -fprint0 -fprintf
 *                -delete -exec -execdir -ok -okdir  (';' and '+' forms)
 *
 * Traversal order, the -depth rule, -prune semantics, symbol handling for
 * -P/-L/-H, the time-window rule for -mtime and the ceil() rounding of -size
 * are all taken from the GNU C sources.  The single deliberate deviation is
 * the substring interpretation of bare -name patterns, documented at the top
 * of this file: 'abc' matches '1111abc11111.java'.
 */

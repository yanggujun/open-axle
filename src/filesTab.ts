/**
 * filesTab.ts - the 'Files' tab for the RIGHT-side dock.
 *
 * Shows the CURRENT working directory as a scrollable listing whose look
 * mirrors the 'Change Dir' folder-chooser dialog (see workingDir.css).
 *
 * LOCAL working directories list BOTH folders and files (folders first), via
 * the window.axle.listEntries bridge.
 *
 * REMOTE (ssh://) working directories list their entries via the
 * window.axle.listRemoteDir bridge. When called with includeFiles=true the
 * bridge returns { path, dirs, error } where each `dirs` entry is a name that
 * ends with '/' for DIRECTORIES and does not for files (this is derived from
 * `ls -1Ap`; the marker is preserved by src/main.ts). The view therefore splits
 * those entries on the trailing '/' and renders folders with the FOLDER glyph
 * (expandable: clicking one lazily lists its children using '/'-joined remote
 * paths) and files with the FILE glyph, mirroring the LOCAL listing. The
 * resolved remote path is shown in the editable path box as
 * 'ssh://<server><path>'.
 *
 * The tab also hosts the '...' (Change Dir) button and an EDITABLE current-dir
 * path box. The '...' button opens the folder chooser (via the handler
 * registered with setFilesChangeDirHandler). The path box lets the user type a
 * directory directly: on Enter/blur the typed path is handed to the handler
 * registered with setFilesSetDirHandler, which verifies it and, when valid,
 * switches the active model's working directory (the box reverts on failure).
 *
 * Folders stay expandable: clicking a folder row lazily lists its children on
 * first expand, so the existing folder-open/navigation behaviour is preserved.
 *
 * The listing follows the ACTIVE model: renderer.ts calls setFilesModelName()
 * whenever the active model changes and refreshFiles() whenever the working
 * directory changes, so the panel always reflects the model currently in focus.
 *
 * Presentation lives in src/workingDir.css (.files-card*, .files-item*).
 */

import type { RightTabContext, RightTabInstance } from './rightWorkspace';

/** The dock tab id used to open this view. */
export const FILES_TAB_ID = 'files';

/** A single directory entry returned by the bridge. */
export interface DirEntry {
  name: string;
  type: 'file' | 'folder';
}

/** Result of listing a remote directory. */
export interface RemoteDirResult {
  path: string;
  dirs: string[];
  error: string;
}

/** Bridge methods used by this view (subset of window.axle). */
interface FilesBridge {
  getWorkingDirInfo(
    modelName?: string
  ): Promise<
    | { kind: 'local'; path: string }
    | { kind: 'remote'; serverName: string; path: string }
  >;
  listEntries(dir: string): Promise<DirEntry[]>;
  listRemoteDir(serverName: string, remotePath?: string, includeFiles?: boolean, modelName?: string): Promise<RemoteDirResult>;
  /**
   * Ask the main process to watch a LOCAL directory for filesystem changes.
   * One watcher per directory (non-recursive). Remote ssh:// paths are ignored.
   */
  watchDir(dir: string): Promise<boolean>;
  /** Stop watching a LOCAL directory (folder collapsed or view torn down). */
  unwatchDir(dir: string): Promise<boolean>;
  /** Stop watching every directory (working dir change or view disposal). */
  unwatchAll(): Promise<boolean>;
  /**
   * Subscribe to filesystem-change events from the main process. Each payload
   * carries the directory that changed. Returns an unsubscribe function.
   */
  onFsChanged(callback: (data: { dir: string }) => void): () => void;
}

interface AxleWithFiles {
  axle?: Partial<FilesBridge>;
}

// ---- Module state (single instance inside its dock tab) ----
let bodyEl: HTMLElement | null = null;
let pathInputEl: HTMLInputElement | null = null;

/** The model whose working directory this view reflects (set by renderer). */
let currentModelName: string | null = null;

/** Change-dir handler registered by the renderer; invoked by the '...' button. */
let changeDirHandler: (() => void) | null = null;

/**
 * Typed-path handler registered by the renderer; invoked by the editable path
 * box. It verifies the path and applies it to the active model, resolving true
 * on success (so this view keeps the typed value) or false on failure (so the
 * box reverts to the last shown directory).
 */
let setDirHandler: ((path: string) => Promise<boolean>) | null = null;

/**
 * 'Insert into chat' handler registered by the renderer; invoked when the user
 * DOUBLE-CLICKS a file row so its name is copied into the active model's chat
 * box. When no handler is registered, double-clicking a file is a no-op.
 */
let insertToChatHandler: ((fileName: string) => void) | null = null;

/** The resolved local root path currently shown (local dirs only). */
let rootPath = '';

/** The remote server name whose directories are shown (remote dirs only). */
let remoteServerName = '';

/** The exact text currently shown in the path box (local or ssh:// form). */
let displayedPath = '';

/** Guard so concurrent refreshes do not race their DOM writes. */
let loadToken = 0;

/** Folder and file glyphs used as row icons. */
const FOLDER_ICON = '\uD83D\uDCC1';
const FILE_ICON = '\uD83D\uDCC4';

// ---- Filesystem change tracking (LOCAL directories only) ----
//
// The tab watches ONLY the current working directory and the sub-directories
// the user has EXPANDED, so the OS is not asked to observe the whole tree. Each
// rendered LOCAL directory is recorded here so a change event can re-list just
// that directory (and, transitively, its still-expanded descendants). Remote
// (ssh://) directories are never watched.

/** Debounce window (ms) for coalescing a burst of filesystem events. */
const FS_REFRESH_DEBOUNCE = 150;

/** Per-rendered-directory registry: absolute path -> its container + re-render. */
interface DirRender {
  container: HTMLElement;
  rerender: () => Promise<void>;
}
const dirRegistry = new Map<string, DirRender>();

/** Absolute paths of LOCAL directories currently expanded by the user. */
const expandedDirs = new Set<string>();

/** Directories that reported a change and await the debounced refresh. */
const pendingChanges = new Set<string>();
let changeTimer: number | null = null;

/** Unsubscribe handle for the onFsChanged bridge subscription. */
let unsubscribeFs: (() => void) | null = null;

/** Normalize a path for ancestor/descendant comparison (sep + trailing). */
function normalizeDirPath(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** True when `dir` equals `ancestor` or lives under it. */
function isAncestor(ancestor: string, dir: string): boolean {
  const a = normalizeDirPath(ancestor);
  const d = normalizeDirPath(dir);
  if (!a) return false;
  return a === d || d.startsWith(a + '/');
}

/** Start watching a LOCAL directory (best-effort; ignores missing bridge). */
function watchDirSafe(dir: string): void {
  const axle = getAxle();
  if (axle && typeof axle.watchDir === 'function') {
    void axle.watchDir(dir).catch((e) => console.error('[filesTab] watchDir failed for', dir, e));
  }
}

/** Stop watching a LOCAL directory (best-effort; ignores missing bridge). */
function unwatchDirSafe(dir: string): void {
  const axle = getAxle();
  if (axle && typeof axle.unwatchDir === 'function') {
    void axle.unwatchDir(dir).catch((e) => console.error('[filesTab] unwatchDir failed for', dir, e));
  }
}

/**
 * Forget a directory and every expanded/registered directory beneath it:
 * remove their registry entries, clear their expanded flags and stop their
 * watchers. Used when a folder row is COLLAPSED so no stale watchers remain.
 */
function forgetSubtree(dir: string): void {
  for (const key of Array.from(dirRegistry.keys())) {
    if (isAncestor(dir, key)) {
      dirRegistry.delete(key);
      expandedDirs.delete(key);
      unwatchDirSafe(key);
    }
  }
}

/**
 * Drop ALL directory tracking (registry, expanded flags, pending refreshes and
 * watchers). Used when the listing is reloaded for a new working directory and
 * when the view is disposed.
 */
function clearDirTracking(): void {
  if (changeTimer !== null) {
    window.clearTimeout(changeTimer);
    changeTimer = null;
  }
  pendingChanges.clear();
  expandedDirs.clear();
  dirRegistry.clear();
  const axle = getAxle();
  if (axle && typeof axle.unwatchAll === 'function') {
    void axle.unwatchAll().catch((e) => console.error('[filesTab] unwatchAll failed:', e));
  }
}

/** Re-list a single (already rendered) directory in place, if still tracked. */
function refreshDir(dir: string): void {
  const entry = dirRegistry.get(dir);
  if (entry) void entry.rerender();
}

/**
 * Handle a filesystem-change notification from the main process. Changes are
 * coalesced for FS_REFRESH_DEBOUNCE ms, then each affected directory is
 * re-listed in place. Because expansion state lives in `expandedDirs`, a
 * re-listed directory re-renders its still-expanded descendants too.
 */
function onFsChange(data: { dir: string }): void {
  if (!data || typeof data.dir !== 'string') return;
  if (!dirRegistry.has(data.dir)) return;
  pendingChanges.add(data.dir);
  if (changeTimer !== null) window.clearTimeout(changeTimer);
  changeTimer = window.setTimeout(() => {
    changeTimer = null;
    const dirs = Array.from(pendingChanges);
    pendingChanges.clear();
    for (const d of dirs) refreshDir(d);
  }, FS_REFRESH_DEBOUNCE);
}

/** Join a child name onto a LOCAL directory path using the path's separator. */
function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/**
 * Join a child name onto a REMOTE directory path. Remote hosts are
 * Linux-like, so '/' is always used as the separator.
 */
function joinRemotePath(dir: string, name: string): string {
  if (!dir) return '/' + name;
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/** Read the bridge (may be undefined during early startup). */
function getAxle(): Partial<FilesBridge> | undefined {
  return (window as unknown as AxleWithFiles).axle;
}

/** Append a hint/placeholder line into a specific container. */
function hintInto(container: HTMLElement, text: string): void {
  const hint = document.createElement('div');
  hint.className = 'files-hint';
  hint.textContent = text;
  container.appendChild(hint);
}

/** Show a short text line in the root listing body (clears it first). */
function showHint(text: string): void {
  if (!bodyEl) return;
  bodyEl.innerHTML = '';
  hintInto(bodyEl, text);
}

/** Reflect a directory (or ssh:// label) in the editable path box. */
function setDisplayedPath(value: string): void {
  displayedPath = value;
  if (pathInputEl) {
    pathInputEl.value = value;
    pathInputEl.title = value;
  }
}

/**
 * List a LOCAL directory and render its children into `container`, folders
 * first and alphabetically within each group. Folder rows carry a disclosure
 * caret and a lazily-loaded children container; file rows are simple leaves.
 * Row styling mirrors the 'Change Dir' dialog's list rows.
 */
async function renderDir(container: HTMLElement, dir: string): Promise<void> {
  const axle = getAxle();
  if (!axle || typeof axle.listEntries !== 'function') {
    hintInto(container, 'File listing is unavailable: the application bridge is not ready.');
    return;
  }

  // Register this directory so an OS change event can re-list just it, and ask
  // the main process to watch it (LOCAL directories only; remote is elsewhere).
  dirRegistry.set(dir, { container, rerender: () => renderDir(container, dir) });
  watchDirSafe(dir);

  let entries: DirEntry[] = [];
  try {
    entries = await axle.listEntries(dir);
  } catch (e) {
    console.error('[filesTab] listEntries failed for', dir, e);
    entries = [];
  }

  // Rebuild from scratch so a re-render (from a change event) never duplicates
  // rows while preserving the expanded sub-directories restored below.
  container.innerHTML = '';

  if (entries.length === 0) {
    hintInto(container, '(empty)');
    return;
  }

  // Folders first, then files; case-insensitive alphabetical within each group.
  const sorted = entries.slice().sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  // Folder rows are remembered so still-expanded ones can be re-opened and
  // re-listed after this (re)render, keeping the current dir and every expanded
  // sub-directory up to date.
  const folderRows: { childPath: string; children: HTMLElement; caret: HTMLElement }[] = [];

  for (const entry of sorted) {
    const row = document.createElement('div');
    row.className = 'files-item ' + (entry.type === 'folder' ? 'folder' : 'file');

    // Leading caret: toggles folders; empty on files so names stay aligned.
    const caret = document.createElement('span');
    caret.className = 'files-caret';

    const icon = document.createElement('span');
    icon.className = 'files-item-icon';

    const name = document.createElement('span');
    name.className = 'files-item-name';
    name.textContent = entry.name;

    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(name);

    if (entry.type === 'folder') {
      const childPath = joinPath(dir, entry.name);

      caret.textContent = '\u25b8'; // collapsed triangle
      icon.textContent = FOLDER_ICON;

      const children = document.createElement('div');
      children.className = 'files-children';
      children.classList.add('hidden');

      container.appendChild(row);
      container.appendChild(children);

      row.addEventListener('click', () => {
        const expanded = !children.classList.contains('hidden');
        if (!expanded) {
          // Expanding: remember it, watch it, and lazily list it the first time.
          expandedDirs.add(childPath);
          watchDirSafe(childPath);
          children.classList.remove('hidden');
          caret.textContent = '\u25be'; // expanded triangle
          if (children.childElementCount === 0) {
            void renderDir(children, childPath);
          }
        } else {
          // Collapsing: unwatch this folder AND every expanded descendant and
          // drop the now-hidden content so a later expand re-lists it fresh.
          children.classList.add('hidden');
          caret.textContent = '\u25b8';
          children.innerHTML = '';
          forgetSubtree(childPath);
        }
      });

      folderRows.push({ childPath, children, caret });
    } else {
      icon.textContent = FILE_ICON;
      // DOUBLE-CLICKING a file copies its name into the active chat box (via
      // the renderer-supplied handler), so the name can be referenced in the
      // next message without retyping it.
      row.title = 'Double-click to insert this file name into the chat box';
      row.addEventListener('dblclick', () => {
        if (insertToChatHandler) insertToChatHandler(entry.name);
      });
      container.appendChild(row);
    }
  }

  // Restore previously-expanded sub-directories: re-open them and re-list their
  // content so a change-driven re-render refreshes the current directory AND
  // all of its expanded sub-directories, while collapsed ones stay untouched.
  for (const fr of folderRows) {
    if (expandedDirs.has(fr.childPath)) {
      fr.children.classList.remove('hidden');
      fr.caret.textContent = '\u25be'; // expanded triangle
      void renderDir(fr.children, fr.childPath);
    }
  }
}

/**
 * List a REMOTE directory (folders only, since the bridge returns just dir
 * names) and render its children into `container`, alphabetically. Folder rows
 * carry a disclosure caret and a lazily-loaded children container; expanding a
 * folder lists its children via listRemoteDir with a '/'-joined remote path.
 *
 * Returns the RESOLVED remote path reported by the server (used to populate the
 * editable path box); on error or empty it returns `dir` unchanged.
 */
async function renderRemoteDir(
  container: HTMLElement,
  server: string,
  dir: string
): Promise<string> {
  const axle = getAxle();
  if (!axle || typeof axle.listRemoteDir !== 'function') {
    hintInto(container, 'Remote listing is unavailable: the application bridge is not ready.');
    return dir;
  }

  let result: RemoteDirResult;
  try {
    result = await axle.listRemoteDir(server, dir || undefined, true, currentModelName ?? undefined);
  } catch (e) {
    console.error('[filesTab] listRemoteDir failed for', dir, e);
    hintInto(container, 'Remote listing failed: ' + (e instanceof Error ? e.message : String(e)));
    return dir;
  }

  if (result.error) {
    hintInto(container, result.error);
    return result.path || dir;
  }

  const basePath = result.path || dir;
  const entries = result.dirs || [];

  // The bridge lists remote entries with `ls -1Ap`, which appends a trailing
  // '/' to DIRECTORY names only (files never get one) when includeFiles is
  // true. Split on that marker so folders and files render with the correct
  // icon, mirroring the LOCAL renderer (renderDir).
  const folderNames: string[] = [];
  const fileNames: string[] = [];
  for (const raw of entries) {
    if (raw.endsWith('/')) {
      folderNames.push(raw.slice(0, -1));
    } else {
      fileNames.push(raw);
    }
  }

  if (folderNames.length === 0 && fileNames.length === 0) {
    hintInto(container, '(empty)');
    return basePath;
  }

  // Folders first, then files; each group case-insensitively alphabetical.
  const sortNames = (a: string, b: string): number =>
    a.localeCompare(b, undefined, { sensitivity: 'base' });
  const sortedFolders = folderNames.slice().sort(sortNames);
  const sortedFiles = fileNames.slice().sort(sortNames);

  for (const name of sortedFolders) {
    const row = document.createElement('div');
    row.className = 'files-item folder';

    const caret = document.createElement('span');
    caret.className = 'files-caret';
    caret.textContent = '\u25b8'; // collapsed triangle

    const icon = document.createElement('span');
    icon.className = 'files-item-icon';
    icon.textContent = FOLDER_ICON;

    const nameEl = document.createElement('span');
    nameEl.className = 'files-item-name';
    nameEl.textContent = name;

    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(nameEl);

    const childPath = joinRemotePath(basePath, name);

    const children = document.createElement('div');
    children.className = 'files-children';
    children.classList.add('hidden');

    let loaded = false;
    container.appendChild(row);
    container.appendChild(children);

    row.addEventListener('click', () => {
      const expanded = !children.classList.contains('hidden');
      if (!expanded) {
        // Expanding: lazily list children the first time.
        if (!loaded) {
          loaded = true;
          void renderRemoteDir(children, server, childPath);
        }
        children.classList.remove('hidden');
        caret.textContent = '\u25be'; // expanded triangle
      } else {
        children.classList.add('hidden');
        caret.textContent = '\u25b8';
      }
    });
  }

  // Files: simple leaves (like the LOCAL renderer's file rows). The empty
  // caret keeps file names aligned with folder names; files do not expand.
  for (const name of sortedFiles) {
    const row = document.createElement('div');
    row.className = 'files-item file';

    const caret = document.createElement('span');
    caret.className = 'files-caret';

    const icon = document.createElement('span');
    icon.className = 'files-item-icon';
    icon.textContent = FILE_ICON;

    const nameEl = document.createElement('span');
    nameEl.className = 'files-item-name';
    nameEl.textContent = name;

    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(nameEl);

    // DOUBLE-CLICKING a remote file copies its name into the active chat box
    // (same behaviour as LOCAL file rows).
    row.title = 'Double-click to insert this file name into the chat box';
    row.addEventListener('dblclick', () => {
      if (insertToChatHandler) insertToChatHandler(name);
    });

    container.appendChild(row);
  }

  return basePath;
}

/** Resolve and render the current working directory listing. */
async function loadRoot(): Promise<void> {
  if (!bodyEl) return;

  const token = ++loadToken;

  // A (re)load reflects a new working directory: drop the previous directory's
  // registry, expansion state and OS watchers before listing the new one.
  clearDirTracking();

  bodyEl.innerHTML = '';

  const axle = getAxle();
  if (!axle || typeof axle.getWorkingDirInfo !== 'function') {
    setDisplayedPath('');
    showHint('File listing is unavailable: the application bridge is not ready.');
    return;
  }

  let info:
    | { kind: 'local'; path: string }
    | { kind: 'remote'; serverName: string; path: string }
    | null = null;
  try {
    info = await axle.getWorkingDirInfo(currentModelName ?? undefined);
  } catch (e) {
    console.error('[filesTab] getWorkingDirInfo failed:', e);
    info = null;
  }

  // A newer load started while we awaited; drop this stale result.
  if (token !== loadToken) return;

  if (!info) {
    setDisplayedPath('');
    showHint('Unable to resolve the current working directory.');
    return;
  }

  if (info.kind === 'remote') {
    // Remote working directory: list its FOLDERS via the listRemoteDir bridge.
    // Remote hosts are Linux-like, so a '/' path browses from the root.
    rootPath = '';
    remoteServerName = info.serverName;

    if (!axle || typeof axle.listRemoteDir !== 'function') {
      setDisplayedPath('ssh://' + info.serverName + info.path);
      showHint('Remote listing is unavailable: the application bridge is not ready.');
      return;
    }

    const resolved = await renderRemoteDir(bodyEl, info.serverName, info.path || '');
    // Drop the result if a newer load started while we awaited.
    if (token !== loadToken) return;

    // Show the resolved remote path in the editable path box.
    setDisplayedPath('ssh://' + info.serverName + resolved);
    return;
  }

  // Local working directory: list folders AND files via the listEntries bridge.
  remoteServerName = '';
  rootPath = info.path || '';
  setDisplayedPath(rootPath);

  if (!rootPath) {
    showHint('No working directory set.');
    return;
  }

  await renderDir(bodyEl, rootPath);
}

/**
 * Commit a user-typed path from the editable box: hand it to the renderer's
 * typed-path handler, which VERIFIES it and, only when valid, changes the
 * active model's working directory. On success the box keeps the typed value
 * (the renderer then refreshes the listing); on failure the box reverts to the
 * last shown directory and flashes an invalid state.
 */
async function commitTypedPath(): Promise<void> {
  if (!pathInputEl) return;

  const typed = pathInputEl.value.trim();

  // Nothing typed, or unchanged from what is already shown: reset and stop.
  if (!typed || typed === displayedPath) {
    pathInputEl.value = displayedPath;
    return;
  }

  if (!setDirHandler) {
    // Renderer handler not registered yet: cannot verify/apply. Revert.
    pathInputEl.value = displayedPath;
    return;
  }

  let ok = false;
  try {
    ok = await setDirHandler(typed);
  } catch (e) {
    console.error('[filesTab] change dir failed:', e);
    ok = false;
  }

  if (ok) {
    // The renderer reloads the listing (refreshFiles) and that will set the box
    // to the new directory; reflect it immediately for responsiveness too.
    setDisplayedPath(typed);
  } else {
    // Verification failed: revert and flash an invalid state briefly.
    const el = pathInputEl;
    el.value = displayedPath;
    el.classList.add('files-invalid');
    window.setTimeout(() => {
      if (pathInputEl === el) el.classList.remove('files-invalid');
    }, 1200);
  }
}

/**
 * Build the 'Files' dock tab content inside ctx.container and return its
 * lifecycle instance. Called once by the dock when the tab is first opened.
 *
 * The markup mirrors the 'Change Dir' dialog's card (see workingDir.css): a
 * .files-card holds a header, a path row (the '...' Change Dir button plus an
 * EDITABLE current-dir box) and a scrollable list.
 */
export function buildFilesView(ctx: RightTabContext): RightTabInstance {
  const root = document.createElement('div');
  root.className = 'files-card';

  const body = document.createElement('div');
  body.className = 'files-card-body';

  // Path row: the '...' (Change Dir) button on the LEFT of the current-dir
  // box. The button opens the folder chooser through the renderer-supplied
  // handler (setFilesChangeDirHandler); without one it is a harmless no-op.
  const pathRow = document.createElement('div');
  pathRow.className = 'files-card-pathrow';

  const changeDirBtn = document.createElement('button');
  changeDirBtn.className = 'files-change-dir';
  changeDirBtn.textContent = '...';
  changeDirBtn.title = 'Change the working directory';
  changeDirBtn.addEventListener('click', () => {
    if (changeDirHandler) changeDirHandler();
  });
  pathRow.appendChild(changeDirBtn);

  // Editable current-dir box: the user can type a directory and press Enter.
  // On Enter/blur the typed path is verified and (when valid) applied to the
  // active model via the renderer-supplied handler (setFilesSetDirHandler).
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'files-card-path';
  input.placeholder = 'Type a directory path and press Enter';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.title = '';

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Commit via the blur handler so there is a single code path.
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.value = displayedPath;
      input.blur();
    }
  });

  input.addEventListener('blur', (ev: FocusEvent) => {
    // When focus moves to the '...' button, let the chooser handle the change
    // instead of committing the (possibly stale) typed text.
    const related = ev.relatedTarget as Node | null;
    if (related === changeDirBtn) return;
    void commitTypedPath();
  });

  pathInputEl = input;
  pathRow.appendChild(input);

  body.appendChild(pathRow);
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'files-refresh';
  refreshBtn.textContent = '\u21bb';
  refreshBtn.title = 'Reload the listing';
  refreshBtn.addEventListener('click', () => void loadRoot());
  // Place the Refresh button on the SAME row as the path box (to the right of
  // the editable current-dir input), next to the '...' (Change Dir) button,
  // rather than on a separate line below the path row.
  pathRow.appendChild(refreshBtn);

  // Scrollable list (mirrors the dialog's .dir-dialog-list).
  bodyEl = document.createElement('div');
  bodyEl.className = 'files-card-list';
  body.appendChild(bodyEl);

  root.appendChild(body);
  ctx.container.appendChild(root);

  // Subscribe to filesystem-change events so the OS updating the current
  // working directory (or any expanded sub-directory) refreshes the listing.
  const axle = getAxle();
  if (axle && typeof axle.onFsChanged === 'function') {
    unsubscribeFs = axle.onFsChanged(onFsChange);
  }

  // Load the listing immediately.
  void loadRoot();

  return {
    el: root,
    refresh: () => void loadRoot(),
    dispose: () => {
      // Release the filesystem subscription and every directory watcher so no
      // OS handle or change listener is left running after the tab closes.
      if (unsubscribeFs) {
        try {
          unsubscribeFs();
        } catch (e) {
          console.error('[filesTab] onFsChanged unsubscribe failed:', e);
        }
        unsubscribeFs = null;
      }
      clearDirTracking();

      bodyEl = null;
      pathInputEl = null;
      loadToken++;
    },
  };
}

/** Reload the listing from disk (called when the working dir changes). */
export function refreshFiles(): void {
  if (bodyEl) void loadRoot();
}

/**
 * Point this view at a model's working directory (called by the renderer on
 * model switch) and reload it.
 */
export function setFilesModelName(modelName: string | null): void {
  currentModelName = modelName;
  if (bodyEl) void loadRoot();
}

/**
 * Register the handler invoked by the Files tab's '...' (Change Dir) button.
 * The renderer supplies the handler that opens the folder chooser and applies
 * the chosen directory to the active model (see renderer.ts).
 */
export function setFilesChangeDirHandler(fn: (() => void) | null): void {
  changeDirHandler = fn;
}

/**
 * Register the handler invoked when the user types a path in the editable box.
 * The renderer supplies the handler that verifies the path and, when valid,
 * applies it to the active model; it resolves true on success (the box keeps
 * the typed value) or false on failure (the box reverts).
 */
export function setFilesSetDirHandler(fn: ((path: string) => Promise<boolean>) | null): void {
  setDirHandler = fn;
}

/**
 * Register the handler invoked when the user DOUBLE-CLICKS a FILE row. The
 * renderer supplies the handler that copies the file's name into the active
 * model's chat box (see renderer.ts). Passing null disables the behaviour.
 */
export function setFilesInsertToChatHandler(fn: ((fileName: string) => void) | null): void {
  insertToChatHandler = fn;
}

/** The local root path currently shown (empty when remote/unresolved). */
export function getFilesRootPath(): string {
  return rootPath;
}

/** The remote server name currently shown (empty when local/unresolved). */
export function getFilesRemoteServerName(): string {
  return remoteServerName;
}

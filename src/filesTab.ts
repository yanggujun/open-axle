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
import { getFileIcon } from './fileIcons';
import { openFileEditor } from './fileEditor';
import { openImageViewer } from './imageViewer';

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
  /**
   * Ask the main process whether a file can be opened in the 'Edit' dialog.
   * The check needs fs and the shared byte sniffer, so it only runs in main.
   */
  canEditFile(
    filePath: string,
    modelName?: string
  ): Promise<{ editable: boolean; reason: string; }>;
  /** Read a file as RAW text (no code fence) for the 'Edit' dialog. */
  readFileRaw(
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; content?: string; error?: string; }>;
  /** Persist text edited in the 'Edit' dialog. */
  writeFileRaw(
    filePath: string,
    content: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string; }>;
  /**
   * Ask the main process whether a file can be shown by the 'View' menu item.
   * The image whitelist lives in the shared helpers (which import fs), so the
   * verdict is computed in main. Only the extension is inspected, so the answer
   * is available for local files and ssh:// paths without opening a connection.
   */
  canViewFile(
    filePath: string,
    modelName?: string
  ): Promise<{ viewable: boolean; reason: string; }>;
  /**
   * Read an image as base64 plus its MIME type so the 'View' dialog can build a
   * data: URI. Local files are read from disk; ssh:// paths are fetched over
   * SFTP by main.
   */
  readImageFile(
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; base64?: string; mimeType?: string; error?: string; }>;
  /**
   * Create an EMPTY file (New File button). An existing file is never
   * truncated: the clash comes back as an error instead. Remote (ssh://)
   * targets are created over the cached SSH/SFTP connection in main.
   */
  createFile(
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string; }>;
  /** Create a single folder (New Folder button); an existing one is refused. */
  createFolder(
    dirPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string; }>;
  /**
   * Copy a FILE (Copy File button). Folders are refused and an existing
   * destination is never overwritten. Remote copies ride the cached SSH/SFTP
   * connection in main.
   */
  copyFile(
    srcPath: string,
    destPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string; }>;
  /**
   * Copy a file OR a folder, recursively, for the Paste button. Accepts folders
   * and every world combination (local -> local, remote -> remote on the same
   * server, local -> remote, remote -> local). An existing destination is never
   * overwritten: the entry lands under the next free name ('name copy', 'name
   * copy 2', ...) and the final path comes back in `path`.
   */
  copyEntry?(
    srcPath: string,
    destPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string; path?: string; }>;
  /**
   * Local files currently on the OPERATING SYSTEM clipboard. Used by Paste so a
   * file copied in Explorer/Finder can be pasted into the listing. Remote paths
   * are never reported (they have no OS representation).
   */
  getClipboardFiles?(): Promise<{ ok: boolean; files: string[]; error?: string; }>;
  /**
   * Put LOCAL files on the OPERATING SYSTEM clipboard so Copy can be pasted into
   * another application. Remote paths are refused by the main process.
   */
  setClipboardFiles?(paths: string[]): Promise<{ ok: boolean; error?: string; }>;
  /** Delete a file, or a folder together with its content (Delete button). */
  deleteEntry(
    targetPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string; }>;
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

// ---- File selection (single-click highlighting) ----
//
// A FILE row highlights its name when SINGLE-CLICKED (a folder row keeps its
// own expand/collapse click). Exactly one file row is selected at a time, and
// the choice is remembered by a stable key (directory + separator + name) so
// it survives the directory re-renders triggered by filesystem-change events.

/** Stable key of the currently selected row (null when none). */
let selectedFileKey: string | null = null;

/** The DOM row currently carrying the 'selected' class (for fast clearing). */
let selectedRowEl: HTMLElement | null = null;

/** Build the stable selection key for an entry inside a directory. */
function fileKey(dir: string, name: string): string {
  return normalizeDirPath(dir) + '\u0000' + name;
}

/**
 * The entry currently selected in the listing. Files and folders can both be
 * selected; `type` gates the toolbar actions, because Copy File only applies to
 * files while Delete applies to either kind.
 */
interface SelectedEntry {
  /** The directory the entry lives in (as handed to the listing bridge). */
  dir: string;
  /** The entry's own name, without any path part. */
  name: string;
  /** Entry kind, used to enable/disable the toolbar actions. */
  type: 'file' | 'folder';
  /** True when the entry lives on a remote (ssh://) server. */
  remote: boolean;
  /** Remote server name (remote entries only). */
  server?: string;
  /** Full bridge path: an absolute local path, or an 'ssh://<server>/...' URL. */
  path: string;
}

/** The currently selected entry, or null when nothing is selected. */
let selectedEntry: SelectedEntry | null = null;

/** Kind of the listing currently shown (null until the first load). */
let currentKind: 'local' | 'remote' | null = null;

/** The remote directory currently listed (empty for local listings). */
let currentRemoteDir = '';

/**
 * What the Copy button captured, or null when nothing has been copied yet. The
 * entry's OWN path (not just its name) is kept, so the source can live in a
 * different directory or on a different server from the paste target. Copy and
 * Paste are entirely in-memory: nothing is written until Paste is pressed.
 */
let clipboardEntry: {
  /** The entry's own name, used to derive the pasted name. */
  name: string;
  /** Entry kind; both files and folders can be copied. */
  type: 'file' | 'folder';
  /** True when the source lives on a remote (ssh://) server. */
  remote: boolean;
  /** Remote server name (remote sources only). */
  server?: string;
  /** Full source path: an absolute local path or an 'ssh://<server>/...' URL. */
  path: string;
} | null = null;

/**
 * How many LOCAL files the OPERATING SYSTEM clipboard currently holds. Cached so
 * the Paste button can be enabled/disabled synchronously: reading the OS
 * clipboard is asynchronous, and the toolbar is repainted on every selection.
 * Refreshed by probeClipboardCount() when the view is built, when the window
 * regains focus (the user may have copied something in another application) and
 * after a copy or paste.
 */
let systemClipboardCount = 0;

/** Focus listener that re-probes the OS clipboard (removed on dispose). */
let clipboardFocusHandler: (() => void) | null = null;

/**
 * Refresh the cached count of LOCAL files on the OS clipboard and repaint the
 * toolbar, since Paste may become available (or unavailable) as a result.
 */
async function probeClipboardCount(): Promise<void> {
  const axle = getAxle();
  if (!axle || typeof axle.getClipboardFiles !== 'function') {
    systemClipboardCount = 0;
    updateActionButtons();
    return;
  }
  try {
    const result = await axle.getClipboardFiles();
    systemClipboardCount = result && result.ok && Array.isArray(result.files) ? result.files.length : 0;
  } catch {
    systemClipboardCount = 0;
  }
  updateActionButtons();
}

/** The toolbar buttons that act on the listing/selection (set on build). */
let actionButtons: {
  newFile: HTMLButtonElement;
  newFolder: HTMLButtonElement;
  copyFile: HTMLButtonElement;
  paste: HTMLButtonElement;
  deleteEntry: HTMLButtonElement;
} | null = null;

/**
 * Select `row` (which highlights its name via the .selected class in
 * workingDir.css), remember the entry it represents and refresh the toolbar.
 * Clearing the highlight from the previously selected row keeps exactly ONE
 * name highlighted.
 */
function markSelected(row: HTMLElement, key: string, entry: SelectedEntry): void {
  if (selectedRowEl && selectedRowEl !== row) {
    selectedRowEl.classList.remove('selected');
  }
  selectedFileKey = key;
  selectedRowEl = row;
  selectedEntry = entry;
  row.classList.add('selected');
  updateActionButtons();
}

/**
 * Enable/disable the toolbar actions for what is shown and selected:
 * New File / New Folder need an open directory (they create inside it),
 * Copy needs any selected entry (files AND folders are copyable), Paste needs
 * something already copied plus a destination directory to paste into, and
 * Delete needs any selected entry.
 */
function updateActionButtons(): void {
  if (!actionButtons) return;
  const hasDir = currentKind === 'remote' ? Boolean(currentRemoteDir) : Boolean(rootPath);
  const entry = selectedEntry;
  actionButtons.newFile.disabled = !hasDir;
  actionButtons.newFolder.disabled = !hasDir;
  actionButtons.copyFile.disabled = !(hasDir && entry);
  // Paste has something to do when either clipboard is populated. The in-memory
  // entry covers REMOTE sources (which cannot ride the OS clipboard); the OS
  // clipboard is only consulted while a LOCAL directory is shown, because that
  // is the only place its local paths can be written to.
  const localListing = currentKind !== 'remote';
  const hasPasteSource = Boolean(clipboardEntry) || (localListing && systemClipboardCount > 0);
  actionButtons.paste.disabled = !(hasDir && hasPasteSource);
  actionButtons.deleteEntry.disabled = !(hasDir && entry);
}

/**
 * The directory new entries are created in: the listed remote directory, or the
 * local root. Both are empty before the first successful load.
 */
function newEntryDir(): string {
  return currentKind === 'remote' ? currentRemoteDir : rootPath;
}

/**
 * Where a create/paste action lands: the HIGHLIGHTED folder when a folder row is
 * selected, otherwise the directory on screen (the remote directory currently
 * listed, or the local root).
 *
 * A highlighted row always belongs to the listing on screen (clearDirTracking
 * drops the selection whenever the listing reloads), so `remote` here always
 * agrees with the world the panel is showing.
 */
function targetLocation(): { dir: string; remote: boolean; server: string } | null {
  const entry = selectedEntry;
  if (entry && entry.type === 'folder') {
    // A row's path is its PARENT directory plus its own name, so the folder the
    // entry represents is the two joined together again.
    return {
      dir: entry.remote
        ? joinRemotePath(entry.dir, entry.name)
        : joinPath(entry.dir, entry.name),
      remote: entry.remote,
      server: entry.remote ? entry.server || remoteServerName : ''
    };
  }

  const dir = newEntryDir();
  if (!dir) return null;
  return { dir, remote: currentKind === 'remote', server: remoteServerName };
}

/** Destination handed to the image / chat-log 'Save' buttons. */
export interface FilesSaveTarget {
  /** Local folder (absolute path) or remote folder (no ssh:// prefix). */
  path: string;
  /** True when the folder lives on an ssh:// server. */
  remote: boolean;
  /** Remote server name (remote targets only). */
  server?: string;
}

/**
 * The FOLDER currently highlighted in the listing, for the image and chat-log
 * 'Save' buttons; null when a file (or nothing) is highlighted, which keeps
 * those buttons writing into the working directory exactly as before.
 *
 * The highlight is resolved when a Save button is CLICKED, so no subscription or
 * change notification is needed between this view and its callers.
 */
export function getFilesHighlightedFolder(): FilesSaveTarget | null {
  const entry = selectedEntry;
  if (!entry || entry.type !== 'folder') return null;
  return {
    path: entry.remote
      ? joinRemotePath(entry.dir, entry.name)
      : joinPath(entry.dir, entry.name),
    remote: entry.remote,
    server: entry.remote ? entry.server || remoteServerName : undefined
  };
}

// NOTE: naming a copy ('name copy', 'name copy 2', ...) is decided by the MAIN
// process when Paste runs (see uniqueEntryName in main.ts), because only main
// can probe a REMOTE destination for a free name. The renderer therefore sends
// the clipboard entry's plain name as the destination and lets main pick the
// final one.

/**
 * Ask the user for a single entry name using an inline modal.
 *
 * window.prompt() does not exist in Electron's renderer. The dialog is hosted
 * by the context-menu panel (.files-ctxmenu) and reuses the EXACT name editor
 * the chat-image 'Save' button opens (styles.css):
 *
 *   .chat-image-save-editor   container (anchored to an image there, so its
 *                             positioning is neutralised inline here)
 *   .chat-image-save-name     the file-name input
 *   .chat-image-save-actions  non-wrapping row with the two buttons
 *   .chat-image-save-confirm  '\u2713' confirms (also Enter)
 *   .chat-image-save-cancel   '\u2715' cancels (also Escape)
 *   .chat-image-save-error    message line, hidden while empty
 *
 * Reusing those classes rather than inventing new ones keeps New File / New
 * Folder, the image Save and the chat-log Save visually identical.
 *
 * Resolves with the trimmed name, or null when the user cancels.
 */
function askForName(title: string, initial: string, okLabel: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    if (!cardEl) {
      resolve(null);
      return;
    }
    // Only one popup may be open at a time (also closes an open context menu).
    closeFileContextMenu();

    const panel = document.createElement('div');
    panel.className = 'files-ctxmenu';
    panel.style.padding = '4px';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.gap = '4px';
    panel.style.width = '250px';

    const caption = document.createElement('div');
    caption.textContent = title;
    panel.appendChild(caption);

    // The name box and the two action buttons reuse the EXACT markup and
    // styles of the chat-image 'Save' name editor (.chat-image-save-editor,
    // -name, -actions, -confirm, -cancel, -error in styles.css), so this dialog
    // now looks and behaves exactly like the image / chat-log Save dialogs:
    // a name box with a '\u2713' confirm and a '\u2715' cancel beside it.
    const editor = document.createElement('div');
    editor.className = 'chat-image-save-editor';
    // The shared rule anchors the editor to the top-right corner of an IMAGE;
    // inside this panel it is an ordinary block, so that is overridden here.
    editor.style.position = 'static';
    editor.style.width = '100%';
    editor.style.maxWidth = '100%';
    editor.style.boxShadow = 'none';

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'chat-image-save-name';
    field.value = initial;
    field.spellcheck = false;
    field.autocomplete = 'off';
    field.title = title;
    editor.appendChild(field);

    // A NON-wrapping row holds the two buttons, so they always render on one
    // line beside the input (same layout as the image editor).
    const row = document.createElement('div');
    row.className = 'chat-image-save-actions';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'chat-image-save-confirm';
    okBtn.textContent = '\u2713';
    okBtn.title = okLabel + ' (Enter)';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'chat-image-save-cancel';
    cancelBtn.textContent = '\u2715';
    cancelBtn.title = 'Cancel (Escape)';

    row.appendChild(okBtn);
    row.appendChild(cancelBtn);
    editor.appendChild(row);

    // Error line: empty by default, so .chat-image-save-error:empty hides it.
    const errorLine = document.createElement('div');
    errorLine.className = 'chat-image-save-error';
    editor.appendChild(errorLine);

    panel.appendChild(editor);

    cardEl.appendChild(panel);

    const detachers: Array<() => void> = [];
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      for (const off of detachers) {
        try {
          off();
        } catch {
          // The listener was already removed; nothing to do.
        }
      }
      panel.remove();
      resolve(value);
    };

    /**
     * Confirm the typed name. An EMPTY box is reported on the shared error line
     * (exactly like the image Save editor) instead of resolving null, so the
     * dialog stays open until the user types something or cancels.
     */
    const submit = (): void => {
      const value = field.value.trim();
      if (!value) {
        errorLine.textContent = 'Please enter a file name.';
        field.focus();
        try {
          field.select();
        } catch {
          // Selection is best-effort (older engines).
        }
        return;
      }
      errorLine.textContent = '';
      finish(value);
    };

    detachers.push(
      onCtx(
        document,
        'mousedown',
        (e: Event) => {
          if (!panel.contains(e.target as Node)) finish(null);
        },
        true
      )
    );
    detachers.push(
      onCtx(
        window,
        'keydown',
        (e: Event) => {
          const key = (e as KeyboardEvent).key;
          if (key === 'Escape') {
            e.preventDefault();
            finish(null);
          } else if (key === 'Enter') {
            e.preventDefault();
            submit();
          }
        },
        true
      )
    );

    okBtn.addEventListener('click', () => submit());
    cancelBtn.addEventListener('click', () => finish(null));

    // Place the dialog near the top of the card, horizontally centred.
    const rect = cardEl.getBoundingClientRect();
    panel.style.left = Math.max(4, Math.round(rect.width / 2 - 125)) + 'px';
    panel.style.top = '40px';

    field.focus();
    field.select();
  });
}

/** True when the typed name is a bare entry name (no path part). */
function isPlainName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return name.indexOf('/') < 0 && name.indexOf('\\') < 0;
}

/**
 * Create a file or folder inside the shown directory, then reload the listing.
 *
 * The name is validated here as well as in main, so a typed separator can never
 * move the creation target out of the directory that is on screen.
 */
async function createEntry(kind: 'file' | 'folder'): Promise<void> {
  const axle = getAxle();
  if (!axle) {
    window.alert('Creating entries is unavailable: the application bridge is not ready.');
    return;
  }
  const canCreate = kind === 'file' ? axle.createFile : axle.createFolder;
  if (typeof canCreate !== 'function') {
    window.alert('Creating entries is unavailable: the application bridge is not ready.');
    return;
  }

  // A highlighted folder is the target; otherwise the directory on screen is.
  const location = targetLocation();
  if (!location) {
    window.alert('No directory is open.');
    return;
  }
  const dir = location.dir;

  const name = await askForName(
    kind === 'file' ? 'New File:' : 'New Folder:',
    '',
    'Create'
  );
  if (!name) return;
  if (!isPlainName(name)) {
    window.alert('Please enter a plain name, without a directory part.');
    return;
  }

  // Remote paths need the ssh:// prefix main parses; local ones are plain paths.
  // The server comes from the resolved location, so creating inside a HIGHLIGHTED
  // folder addresses the right host even when the panel shows another server.
  const target = location.remote
    ? 'ssh://' + location.server + joinRemotePath(dir, name)
    : joinPath(dir, name);
  const modelName = currentModelName ?? undefined;

  try {
    const result = await canCreate(target, modelName);
    if (!result || !result.ok) {
      window.alert((result && result.error) || 'Unable to create the entry.');
      return;
    }
    refreshFiles();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Copy the selected entry so Paste can create it elsewhere.
 *
 * A LOCAL entry is published to the OPERATING SYSTEM clipboard instead of being
 * remembered here, so it can also be pasted in Explorer/Finder and survives an
 * app restart; the in-memory entry is then CLEARED so exactly one clipboard
 * holds the data and Paste never re-uses a stale duplicate. A REMOTE entry has
 * no OS representation, so it is the other way round: the in-memory entry is
 * kept (and the OS-side count reset so Paste is driven by it alone).
 */
async function copySelectedEntry(): Promise<void> {
  const entry = selectedEntry;
  if (!entry) return;

  const axle = getAxle();
  const canUseSystemClipboard = typeof axle?.setClipboardFiles === 'function';

  if (!entry.remote && canUseSystemClipboard) {
    try {
      const result = await axle.setClipboardFiles!([entry.path]);
      if (!result || !result.ok) {
        window.alert((result && result.error) || 'Unable to copy the entry to the system clipboard.');
        return;
      }
      // The OS clipboard is now the single source of truth for this copy.
      clipboardEntry = null;
      systemClipboardCount = 1;
      updateActionButtons();
      return;
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
      return;
    }
  }

  // REMOTE entries (or a bridge without OS-clipboard support) stay in memory.
  clipboardEntry = {
    name: entry.name,
    type: entry.type,
    remote: entry.remote,
    server: entry.server,
    path: entry.path
  };
  systemClipboardCount = 0;
  // Paste becomes available as soon as something is on the clipboard.
  updateActionButtons();
}

/**
 * Create a copy of the clipboard entry inside the directory currently shown.
 *
 * The destination is just the clipboard entry's NAME inside that directory; the
 * main process refuses to overwrite, so an existing entry is stored under the
 * next free name ('name copy', 'name copy 2', ...). Because the clipboard keeps
 * the full source path, pasting works across directories, between a local
 * folder and a server, and for folders as well as files.
 */
/**
 * Copy the OS-clipboard paths into the target directory, one entry at a time.
 *
 * The existing copyEntry bridge does the work, so an existing destination is
 * never overwritten (main stores the copy under 'name copy', 'name copy 2', ...)
 * and folders are copied recursively. Paths that fail are collected so ONE error
 * lists everything that could not be pasted instead of interrupting the run.
 */
async function pastePathList(
  sources: string[],
  location: { dir: string; remote: boolean; server: string },
  axle: Partial<FilesBridge>
): Promise<void> {
  if (typeof axle.copyEntry !== 'function') return;
  const modelName = currentModelName ?? undefined;
  const failures: string[] = [];

  for (const rawSource of sources) {
    // The pasted entry keeps its own name; main picks a free one on a clash.
    // The source is cleaned with the SAME rules main applies when it reads the
    // OS clipboard, so clipboard formatting can never leak into the new name:
    // NUL padding, surrounding quotes, a file:// prefix or a trailing
    // separator are stripped before the basename is taken. A candidate that
    // does not reduce to a real entry name is reported instead of creating a
    // wrongly named copy.
    const source =
      typeof rawSource === 'string'
        ? rawSource
            .replace(/\u0000+$/, '')
            .trim()
            .replace(/^"([\s\S]*)"$/, '$1')
            .trim()
            .replace(/^file:\/\/(?:localhost)?/i, '')
        : '';
    const name = source.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    if (!name || name === '.' || name === '..' || /^[a-zA-Z]:$/.test(name)) {
      failures.push((source || String(rawSource)) + ': not a valid entry name');
      continue;
    }
    const dest = location.remote
      ? 'ssh://' + location.server + joinRemotePath(location.dir, name)
      : joinPath(location.dir, name);
    try {
      const result = await axle.copyEntry(source, dest, modelName);
      if (!result || !result.ok) {
        failures.push(name + ': ' + ((result && result.error) || 'copy failed'));
      }
    } catch (e) {
      failures.push(name + ': ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (failures.length) {
    window.alert('Some entries could not be pasted:\n\n' + failures.join('\n'));
  }
  refreshFiles();
}

async function pasteClipboard(): Promise<void> {
  const axle = getAxle();
  if (!axle || typeof axle.copyEntry !== 'function') {
    window.alert('Pasting is unavailable: the application bridge is not ready.');
    return;
  }

  // A highlighted folder is the target; otherwise the directory on screen is.
  const location = targetLocation();
  if (!location) {
    window.alert('No directory is open.');
    return;
  }
  const dir = location.dir;

  // LOCAL targets prefer the OPERATING SYSTEM clipboard, so files copied in
  // Explorer/Finder (or by the Copy button, which publishes local entries there)
  // can be pasted in. When it holds no files the in-memory entry is used.
  if (!location.remote && typeof axle.getClipboardFiles === 'function') {
    let systemFiles: string[] = [];
    try {
      const clipboardState = await axle.getClipboardFiles();
      systemFiles = clipboardState && clipboardState.ok && Array.isArray(clipboardState.files)
        ? clipboardState.files
        : [];
    } catch {
      systemFiles = [];
    }
    if (systemFiles.length > 0) {
      await pastePathList(systemFiles, location, axle);
      await probeClipboardCount();
      return;
    }
  }

  // In-memory entry: the REMOTE source case, or an empty OS clipboard.
  const clip = clipboardEntry;
  if (!clip) {
    // Nothing to paste after all (the OS clipboard emptied between the probe and
    // the click): refresh the toolbar so the button reflects reality.
    await probeClipboardCount();
    return;
  }

  // Remote targets need the ssh:// prefix main parses; local ones are plain
  // paths. joinPath keeps the platform separator of the visible directory.
  const dest = location.remote
    ? 'ssh://' + location.server + joinRemotePath(dir, clip.name)
    : joinPath(dir, clip.name);
  const modelName = currentModelName ?? undefined;

  try {
    const result = await axle.copyEntry(clip.path, dest, modelName);
    if (!result || !result.ok) {
      window.alert((result && result.error) || 'Unable to paste the entry.');
      return;
    }
    refreshFiles();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Delete the selected file or folder, after an explicit confirmation. A folder
 * is deleted together with everything inside it, which is why the prompt spells
 * that out.
 */
async function deleteSelectedEntry(): Promise<void> {
  const entry = selectedEntry;
  if (!entry) return;

  const axle = getAxle();
  if (!axle || typeof axle.deleteEntry !== 'function') {
    window.alert('Deleting is unavailable: the application bridge is not ready.');
    return;
  }

  const what =
    entry.type === 'folder'
      ? 'the folder "' + entry.name + '" and everything inside it'
      : 'the file "' + entry.name + '"';
  if (!window.confirm('Delete ' + what + '?')) return;

  const modelName = currentModelName ?? undefined;

  try {
    const result = await axle.deleteEntry(entry.path, modelName);
    if (!result || !result.ok) {
      window.alert((result && result.error) || 'Unable to delete the entry.');
      return;
    }
    // The row is gone: drop the selection so the toolbar reflects reality.
    selectedEntry = null;
    selectedFileKey = null;
    selectedRowEl = null;
    updateActionButtons();
    refreshFiles();
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

// ---- File context menu (right-click -> 'View' / 'Edit') ----
//
// Right-clicking a FILE row selects it and opens a small popup with two items:
// 'View' (preview an image) and 'Edit' (open the text editor). Each item is
// enabled independently: 'View' needs a whitelisted image extension, 'Edit'
// needs a text file, so most files show one enabled and one disabled item.
// The menu is appended to the view's card (not to document.body) so it is
// positioned relative to the listing and is removed together with it. Only ONE
// menu exists at a time; every dismiss listener it installs is remembered and
// detached when it closes, so nothing leaks.

/** The '.files-card' element the listing is rendered into (set on build). */
let cardEl: HTMLElement | null = null;

/** The single open context menu, if any. */
let ctxMenuEl: HTMLElement | null = null;

/** Teardown callbacks for the open menu's dismiss listeners. */
let ctxDismissers: Array<() => void> = [];

/**
 * Close the file context menu (if open) and detach every dismiss listener.
 * Idempotent, so it is safe to call from the view's dispose() as well.
 */
function closeFileContextMenu(): void {
  for (const off of ctxDismissers) {
    try {
      off();
    } catch {
      // The listener was already removed; nothing to do.
    }
  }
  ctxDismissers = [];
  if (ctxMenuEl) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
  }
}

/** Add a listener and return a function that removes it again. */
function onCtx(
  target: EventTarget,
  type: string,
  fn: EventListener,
  capture: boolean
): () => void {
  target.addEventListener(type, fn, capture);
  return () => target.removeEventListener(type, fn, capture);
}

/**
 * Read a file and open the Monaco editor dialog for it.
 *
 * The editability verdict is re-checked here even though the menu item is
 * already disabled for binary/unsupported files: the check is cheap and keeps
 * the write path guarded no matter how the menu was reached.
 */
async function startEditFile(
  filePath: string,
  fileName: string,
  editable: boolean,
  isRemote: boolean
): Promise<void> {
  // The model name lets the main process resolve the remote server's
  // credentials when the path is an ssh:// URL; it is ignored for local files.
  const modelName = currentModelName ?? undefined;
  closeFileContextMenu();
  if (!editable) return;

  const axle = getAxle();
  if (
    !axle ||
    typeof axle.canEditFile !== 'function' ||
    typeof axle.readFileRaw !== 'function' ||
    typeof axle.writeFileRaw !== 'function'
  ) {
    return;
  }

  try {
    const verdict = await axle.canEditFile(filePath, modelName);
    if (!verdict || !verdict.editable) {
      window.alert(verdict && verdict.reason ? verdict.reason : 'This file cannot be edited.');
      return;
    }

    const read = await axle.readFileRaw(filePath, modelName);
    if (!read || !read.ok || typeof read.content !== 'string') {
      window.alert((read && read.error) || 'Unable to read this file.');
      return;
    }

    openFileEditor({
      fileName,
      filePath,
      content: read.content,
      save: async (text) => {
        const written = await axle.writeFileRaw!(filePath, text, modelName);
        // Remote directories have no filesystem watcher, so re-list them
        // explicitly after a successful save; local ones refresh on their own.
        if (written && written.ok && isRemote) refreshFiles();
        return written;
      }
    });
  } catch (e) {
    console.error('[filesTab] Failed to open the editor for', filePath, e);
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Read an image and show it in the preview dialog.
 *
 * The viewability verdict is re-checked here even though the menu item is
 * already disabled for other files: the check is cheap and keeps the read path
 * guarded no matter how the menu was reached. Failures surface through
 * window.alert, exactly like the 'Edit' path.
 */
async function startViewFile(
  filePath: string,
  fileName: string,
  viewable: boolean
): Promise<void> {
  const modelName = currentModelName ?? undefined;
  closeFileContextMenu();
  if (!viewable) return;

  const axle = getAxle();
  if (!axle || typeof axle.readImageFile !== 'function') return;

  try {
    const result = await axle.readImageFile(filePath, modelName);
    if (
      !result ||
      !result.ok ||
      typeof result.base64 !== 'string' ||
      typeof result.mimeType !== 'string'
    ) {
      window.alert((result && result.error) || 'Unable to read this image.');
      return;
    }

    openImageViewer({
      fileName,
      filePath,
      mimeType: result.mimeType,
      base64: result.base64
    });
  } catch (e) {
    console.error('[filesTab] Failed to open the image viewer for', filePath, e);
    window.alert(e instanceof Error ? e.message : String(e));
  }
}

/** Options accepted by openFileContextMenu. */
interface FileContextMenuOptions {
  event: MouseEvent;
  filePath: string;
  fileName: string;
  editable: boolean;
  reason: string;
  /** True when the file is a whitelisted image, so 'View' is enabled. */
  viewable: boolean;
  /** Tooltip shown on the disabled 'View' item (why it cannot be shown). */
  viewReason: string;
  /** True for ssh:// entries: their saves need an explicit listing refresh. */
  isRemote: boolean;
}

/**
 * Open the file context menu at the pointer with the 'View' and 'Edit' items.
 *
 * The two items are gated independently, so a file that is an image shows
 * 'View' enabled and 'Edit' disabled while a text file shows the opposite. A
 * disabled item is dimmed and carries its reason as a tooltip, so the menu
 * always explains itself instead of silently doing nothing.
 */
function openFileContextMenu(opts: FileContextMenuOptions): void {
  closeFileContextMenu();
  if (!cardEl) return;

  const menu = document.createElement('div');
  menu.className = 'files-ctxmenu';

  // 'View' comes first: previewing an image is a read-only action, listed above
  // the editor as it is in most file browsers.
  const viewItem = document.createElement('div');
  viewItem.className = 'files-ctxmenu-item';
  viewItem.textContent = 'View';
  if (!opts.viewable) {
    viewItem.classList.add('disabled');
    viewItem.title = opts.viewReason || 'This file is not an image';
  } else {
    viewItem.title = 'Show ' + opts.fileName;
  }
  viewItem.addEventListener('click', () => {
    void startViewFile(opts.filePath, opts.fileName, opts.viewable);
  });
  menu.appendChild(viewItem);

  const item = document.createElement('div');
  item.className = 'files-ctxmenu-item';
  item.textContent = 'Edit';
  if (!opts.editable) {
    item.classList.add('disabled');
    item.title = opts.reason || 'This file cannot be edited';
  } else {
    item.title = 'Open ' + opts.fileName + ' in the editor';
  }
  item.addEventListener('click', () => {
    void startEditFile(opts.filePath, opts.fileName, opts.editable, opts.isRemote);
  });
  menu.appendChild(item);

  cardEl.appendChild(menu);
  ctxMenuEl = menu;

  // Position the menu at the pointer, clamped inside the card so it can never
  // be drawn outside the view. Coordinates are relative to the card because
  // the menu is absolutely positioned against it (see workingDir.css).
  const rect = cardEl.getBoundingClientRect();
  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;
  let left = opts.event.clientX - rect.left;
  let top = opts.event.clientY - rect.top;
  if (left + menuW > rect.width - 4) left = Math.max(4, rect.width - menuW - 4);
  if (top + menuH > rect.height - 4) top = Math.max(4, rect.height - menuH - 4);
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';

  // Dismiss on an outside click, Escape, a scroll of the listing, or when the
  // window is resized or loses focus. Every listener is torn down on close.
  ctxDismissers.push(
    onCtx(
      document,
      'mousedown',
      (e: Event) => {
        if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) closeFileContextMenu();
      },
      true
    )
  );
  ctxDismissers.push(
    onCtx(
      window,
      'keydown',
      (e: Event) => {
        if ((e as KeyboardEvent).key === 'Escape') {
          e.preventDefault();
          closeFileContextMenu();
        }
      },
      true
    )
  );
  ctxDismissers.push(onCtx(document, 'scroll', () => closeFileContextMenu(), true));
  ctxDismissers.push(onCtx(window, 'resize', () => closeFileContextMenu(), false));
  ctxDismissers.push(onCtx(window, 'blur', () => closeFileContextMenu(), false));
}

// Row icons (folder / per-file-type) are produced as inline SVG documents by
// src/fileIcons.ts (getFileIcon). There are no glyph constants here any more.

// ---- Filesystem change tracking (LOCAL and REMOTE directories) ----
//
// The tab polls ONLY the current working directory and the sub-directories the
// user has EXPANDED, so the whole tree is never walked. A single background
// loop (FS_POLL_INTERVAL ms) re-lists every tracked directory, compares the
// fresh listing with the signature cached when that directory was last painted
// and re-renders just the directories whose contents actually changed.
//
// Because the loop drives the listing itself it works for LOCAL folders (listed
// via listEntries) and for REMOTE ssh:// folders (listed via listRemoteDir)
// alike. An OS filesystem watcher could only ever cover the LOCAL case, which is
// why polling is used for both.

/** Interval (ms) between two passes of the expanded-folder refresh loop. */
const FS_POLL_INTERVAL = 500;

/** Per-rendered-directory registry: key -> its container + re-render. */
interface DirRender {
  container: HTMLElement;
  /** Re-list and repaint this directory in place (keeps expansion state). */
  rerender: () => Promise<void>;
  /** 'local' for a filesystem path, 'remote' for an ssh:// path. */
  kind: 'local' | 'remote';
  /** The RAW directory path (no key prefix), as expected by the bridge. */
  dir: string;
  /** Remote server name (remote entries only). */
  server?: string;
}
const dirRegistry = new Map<string, DirRender>();

/**
 * Keys of the directories currently tracked by the poll loop, LOCAL and REMOTE.
 *
 * A LOCAL key is the plain absolute path; a REMOTE key is prefixed with
 * 'ssh://<server>' (see dirKey) so the same path on two servers never clashes.
 * Every rendered directory is tracked, including the working directory itself,
 * so new or removed entries in the root listing show up without user action.
 */
const expandedDirs = new Set<string>();

/** Last painted listing signature per directory (change detection). */
const dirSignatures = new Map<string, string>();

/** Handle of the background refresh loop, or null when it is not running. */
let pollTimer: number | null = null;

/** Guard so a slow listing never overlaps the next tick of the loop. */
let pollInFlight = false;

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

/** Registry/expansion key for a directory (remote paths are server-scoped). */
function dirKey(kind: 'local' | 'remote', dir: string, server?: string): string {
  return kind === 'remote' ? 'ssh://' + (server || '') + normalizeDirPath(dir) : dir;
}

/** Signature that detects a change in a LOCAL listing (names + types). */
function localSignature(entries: DirEntry[]): string {
  return entries
    .map((e) => (e.type === 'folder' ? 'd:' : 'f:') + e.name)
    .sort()
    .join('\n');
}

/** Signature that detects a change in a REMOTE listing (raw remote names). */
function remoteSignature(names: string[]): string {
  return names.slice().sort().join('\n');
}

/** Start the background refresh loop (idempotent). */
function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => {
    void pollExpandedDirs();
  }, FS_POLL_INTERVAL);
}

/** Stop the background refresh loop (idempotent). */
function stopPolling(): void {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

/**
 * One pass of the background loop: re-list every tracked directory, LOCAL or
 * REMOTE, and repaint the ones whose contents changed since they were painted.
 * An unchanged folder costs one listing call and never touches the DOM, so the
 * loop does not cause the blink a blind re-render would.
 */
async function pollExpandedDirs(): Promise<void> {
  if (pollInFlight) return;
  const axle = getAxle();
  if (!axle) return;

  const keys = Array.from(expandedDirs).filter((k) => dirRegistry.has(k));
  if (keys.length === 0) {
    // Nothing tracked any more (tab torn down): let the loop idle.
    stopPolling();
    return;
  }

  pollInFlight = true;
  try {
    for (const key of keys) {
      // The folder may have been collapsed while an earlier listing ran.
      if (!expandedDirs.has(key)) continue;
      const entry = dirRegistry.get(key);
      if (!entry) continue;

      let fresh: string | null = null;
      try {
        if (entry.kind === 'remote') {
          if (typeof axle.listRemoteDir !== 'function') continue;
          const res = await axle.listRemoteDir(
            entry.server || '',
            entry.dir || undefined,
            true,
            currentModelName ?? undefined
          );
          if (res && !res.error) fresh = remoteSignature(res.dirs || []);
        } else {
          if (typeof axle.listEntries !== 'function') continue;
          fresh = localSignature(await axle.listEntries(entry.dir));
        }
      } catch {
        // A transient failure (server hiccup, folder deleted) is ignored; the
        // next tick simply retries.
        continue;
      }

      if (fresh === null || dirSignatures.get(key) === fresh) continue;

      // Contents changed: remember the new signature and repaint in place.
      dirSignatures.set(key, fresh);
      try {
        await entry.rerender();
      } catch (e) {
        console.error('[filesTab] refresh failed for', entry.dir, e);
      }
    }
  } finally {
    pollInFlight = false;
  }
}

/**
 * Forget a directory and every tracked directory beneath it: drop their registry
 * entries, expansion flags and cached signatures so the poll loop stops listing
 * hidden folders. Used when a folder row is COLLAPSED.
 */
function forgetSubtree(dir: string): void {
  for (const key of Array.from(dirRegistry.keys())) {
    if (isAncestor(dir, key)) {
      dirRegistry.delete(key);
      expandedDirs.delete(key);
      dirSignatures.delete(key);
    }
  }
  // The collapsed folder itself may not be registered any more; make sure its
  // own key is gone so a later expand starts from a fresh listing.
  expandedDirs.delete(dir);
  dirSignatures.delete(dir);
}

/**
 * Drop ALL directory tracking (registry, expansion flags, cached signatures) and
 * stop the poll loop. Used when the listing is reloaded for a new working
 * directory and when the view is disposed.
 */
function clearDirTracking(): void {
  stopPolling();
  expandedDirs.clear();
  dirRegistry.clear();
  dirSignatures.clear();
  pollInFlight = false;
  // The tracked rows are gone, so drop the selection (highlight AND the entry
  // the toolbar acts on) and re-evaluate the buttons.
  selectedFileKey = null;
  selectedRowEl = null;
  selectedEntry = null;
  updateActionButtons();
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

/**
 * Path of a LOCAL file relative to the current working directory (`rootPath`),
 * always using '/' separators. Used when a double-clicked file is inserted into
 * the chat box: the typed path then resolves FROM the working directory, so the
 * file can be opened without the reader having to guess where it lives. When the
 * root is unknown, or the entry somehow sits outside it (a '..' listing), the
 * bare name is returned so the behaviour degrades to the previous one.
 */
function relativeToRoot(dir: string, name: string): string {
  const root = normalizeDirPath(rootPath);
  if (!root) return name;
  const full = normalizeDirPath(joinPath(dir, name));
  // Compare case-insensitively so a Windows drive letter typed in a different
  // case ('C:' vs 'c:') still matches the root the listing was rendered for.
  const lowerFull = full.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (lowerFull === lowerRoot) return name;
  if (lowerFull.startsWith(lowerRoot + '/')) {
    const rel = full.slice(root.length + 1).replace(/^\/+/, '');
    return rel || name;
  }
  return name;
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

  // Register this directory with the background poll loop so a change on disk
  // is picked up on the next tick and this exact spot is re-listed in place,
  // without any per-directory OS watcher.
  const trackKey = dirKey('local', dir);
  dirRegistry.set(trackKey, {
    container,
    rerender: () => renderDir(container, dir),
    kind: 'local',
    dir,
  });
  expandedDirs.add(trackKey);
  startPolling();

  let entries: DirEntry[] = [];
  try {
    entries = await axle.listEntries(dir);
  } catch (e) {
    console.error('[filesTab] listEntries failed for', dir, e);
    entries = [];
  }

  // Cache the signature of what is about to be painted: the poll loop compares
  // each fresh listing against it and only repaints directories that changed.
  dirSignatures.set(trackKey, localSignature(entries));

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
      const key = fileKey(dir, entry.name);

      caret.textContent = '\u25b8'; // collapsed triangle
      icon.innerHTML = getFileIcon(entry.name, true);

      // Re-apply the highlight when a poll-driven re-render rebuilds the row, so
      // a selected FOLDER keeps looking selected (files do the same below).
      if (selectedFileKey === key) {
        row.classList.add('selected');
        selectedRowEl = row;
      }

      const children = document.createElement('div');
      children.className = 'files-children';
      children.classList.add('hidden');

      container.appendChild(row);
      container.appendChild(children);

      row.addEventListener('click', () => {
        // Selecting the folder first makes the Delete action apply to it; the
        // expand/collapse behaviour below is unchanged.
        markSelected(row, key, {
          dir,
          name: entry.name,
          type: 'folder',
          remote: false,
          path: childPath
        });
        const expanded = !children.classList.contains('hidden');
        if (!expanded) {
          // Expanding: track it with the poll loop so later changes on disk are
          // noticed, and lazily list it the first time it is opened.
          expandedDirs.add(dirKey('local', childPath));
          startPolling();
          children.classList.remove('hidden');
          caret.textContent = '\u25be'; // expanded triangle
          if (children.childElementCount === 0) {
            void renderDir(children, childPath);
          }
        } else {
          // Collapsing: stop tracking this folder AND every expanded descendant
          // and drop the now-hidden content so a later expand re-lists it fresh.
          children.classList.add('hidden');
          caret.textContent = '\u25b8';
          children.innerHTML = '';
          forgetSubtree(dirKey('local', childPath));
        }
      });

      folderRows.push({ childPath, children, caret });
    } else {
      icon.innerHTML = getFileIcon(entry.name, false);

      // SINGLE-CLICKING a file selects it and HIGHLIGHTS its name (via the
      // .selected class in workingDir.css), moving the highlight off any other
      // row so only one file name is highlighted at a time. The selection is
      // re-applied below when this directory is re-rendered after a change.
      const key = fileKey(dir, entry.name);
      if (selectedFileKey === key) {
        row.classList.add('selected');
        selectedRowEl = row;
      }
      row.addEventListener('click', () =>
        markSelected(row, key, {
          dir,
          name: entry.name,
          type: 'file',
          remote: false,
          path: joinPath(dir, entry.name)
        })
      );

      // DOUBLE-CLICKING a file copies its path RELATIVE TO THE CURRENT WORKING
      // DIRECTORY into the active chat box (via the renderer-supplied handler),
      // so the file can be referenced in the next message without retyping a
      // long absolute path. The path is expressed from the working directory
      // ('src/main.ts', not 'main.ts'), which is the form the agent resolves
      // against its own cwd. A double-click also fires the click handler above,
      // so the row is selected as well.
      row.title = 'Click to select, double-click to insert this file path into the chat box';
      row.addEventListener('dblclick', () => {
        if (insertToChatHandler) insertToChatHandler(relativeToRoot(dir, entry.name));
      });

      // RIGHT-CLICKING a file selects it and opens the context menu with the
      // 'View' and 'Edit' items. Both verdicts are decided by the MAIN process
      // (the image whitelist and the text/byte sniff alike need fs), so the two
      // checks are requested TOGETHER and the menu is drawn once both resolve:
      // drawing it earlier would briefly show the wrong enabled state. Every
      // file still gets the menu, with the reason for a disabled item shown as
      // its tooltip.
      row.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        markSelected(row, key, {
          dir,
          name: entry.name,
          type: 'file',
          remote: false,
          path: joinPath(dir, entry.name)
        });

        const filePath = joinPath(dir, entry.name);
        const modelName = currentModelName ?? undefined;
        const axle = getAxle();
        if (!axle) {
          const reason = 'The application bridge is not ready.';
          openFileContextMenu({
            event: e,
            filePath,
            fileName: entry.name,
            editable: false,
            reason: 'Editing is unavailable: ' + reason,
            viewable: false,
            viewReason: 'Preview is unavailable: ' + reason,
            isRemote: false
          });
          return;
        }

        const editCheck =
          typeof axle.canEditFile === 'function'
            ? axle.canEditFile(filePath, modelName)
            : Promise.resolve({
                editable: false,
                reason: 'Editing is unavailable: the application bridge is not ready.'
              });
        const viewCheck =
          typeof axle.canViewFile === 'function'
            ? axle.canViewFile(filePath, modelName)
            : Promise.resolve({
                viewable: false,
                reason: 'Preview is unavailable: the application bridge is not ready.'
              });

        void Promise.all([editCheck, viewCheck])
          .then(([verdict, preview]) => {
            openFileContextMenu({
              event: e,
              filePath,
              fileName: entry.name,
              editable: Boolean(verdict && verdict.editable),
              reason: (verdict && verdict.reason) || '',
              viewable: Boolean(preview && preview.viewable),
              viewReason: (preview && preview.reason) || '',
              isRemote: false
            });
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            openFileContextMenu({
              event: e,
              filePath,
              fileName: entry.name,
              editable: false,
              reason: message,
              viewable: false,
              viewReason: message,
              isRemote: false
            });
          });
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

  // Register this remote directory with the SAME background poll loop used for
  // local folders, so ssh:// directories refresh by themselves too (an OS
  // filesystem watcher can never see a remote host). The listing just fetched
  // is cached as the baseline the loop compares against.
  const trackKey = dirKey('remote', basePath, server);
  dirRegistry.set(trackKey, {
    container,
    rerender: async (): Promise<void> => {
      await renderRemoteDir(container, server, basePath);
    },
    kind: 'remote',
    dir: basePath,
    server,
  });
  expandedDirs.add(trackKey);
  dirSignatures.set(trackKey, remoteSignature(entries));
  startPolling();

  // The bridge lists remote entries with `ls -1Ap`, which appends a trailing
  // '/' to DIRECTORY names only (files never get one) when includeFiles is
  // true. Split on that marker so folders and files render with the correct
  // icon, mirroring the LOCAL renderer (renderDir).
  // Folder rows are remembered so still-expanded ones can be re-opened and
  // re-listed after this (poll-driven) re-render, keeping the current remote
  // directory and every expanded sub-directory up to date, exactly like the
  // LOCAL renderer does with its folderRows.
  const remoteFolderRows: {
    childPath: string;
    children: HTMLElement;
    caret: HTMLElement;
    reveal: () => void;
  }[] = [];

  const folderNames: string[] = [];
  const fileNames: string[] = [];
  for (const raw of entries) {
    if (raw.endsWith('/')) {
      folderNames.push(raw.slice(0, -1));
    } else {
      fileNames.push(raw);
    }
  }

  // Rebuild from scratch so a poll-driven re-render never duplicates rows; the
  // still-expanded sub-directories are restored at the end of this function.
  container.innerHTML = '';

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
    icon.innerHTML = getFileIcon(name, true);

    const nameEl = document.createElement('span');
    nameEl.className = 'files-item-name';
    nameEl.textContent = name;

    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(nameEl);

    const childPath = joinRemotePath(basePath, name);
    const key = fileKey(basePath, name);

    // Re-apply the highlight when a poll-driven re-render rebuilds this row, so
    // a selected remote FOLDER keeps looking selected (same as local folders).
    if (selectedFileKey === key) {
      row.classList.add('selected');
      selectedRowEl = row;
    }

    const children = document.createElement('div');
    children.className = 'files-children';
    children.classList.add('hidden');

    let loaded = false;
    container.appendChild(row);
    container.appendChild(children);

    // Open this row: track it with the poll loop so its remote listing is
    // re-checked every tick, and list its children when they are not loaded yet.
    // Used both by the click handler and by the restore pass at the end of this
    // function, so a poll repaint keeps expanded sub-folders expanded.
    const reveal = (): void => {
      expandedDirs.add(dirKey('remote', childPath, server));
      startPolling();
      if (!loaded) {
        loaded = true;
        void renderRemoteDir(children, server, childPath);
      }
      children.classList.remove('hidden');
      caret.textContent = '\u25be'; // expanded triangle
    };

    row.addEventListener('click', () => {
      // Selecting the folder first makes the Delete action apply to it; the
      // expand/collapse behaviour below is unchanged.
      markSelected(row, key, {
        dir: basePath,
        name,
        type: 'folder',
        remote: true,
        server,
        path: 'ssh://' + server + childPath
      });
      const expanded = !children.classList.contains('hidden');
      if (!expanded) {
        reveal();
      } else {
        // Collapsing: stop tracking this folder AND every expanded descendant,
        // then drop the hidden content so a later expand re-lists it fresh.
        children.classList.add('hidden');
        caret.textContent = '\u25b8';
        children.innerHTML = '';
        loaded = false;
        forgetSubtree(dirKey('remote', childPath, server));
      }
    });

    remoteFolderRows.push({ childPath, children, caret, reveal });
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
    icon.innerHTML = getFileIcon(name, false);

    const nameEl = document.createElement('span');
    nameEl.className = 'files-item-name';
    nameEl.textContent = name;

    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(nameEl);

    // SINGLE-CLICKING a remote file selects it and HIGHLIGHTS its name (same
    // behaviour as LOCAL file rows), moving the highlight off any other row so
    // only one file name is highlighted at a time. The selection is re-applied
    // when this remote directory is re-rendered.
    const key = fileKey(basePath, name);
    if (selectedFileKey === key) {
      row.classList.add('selected');
      selectedRowEl = row;
    }
    row.addEventListener('click', () =>
      markSelected(row, key, {
        dir: basePath,
        name,
        type: 'file',
        remote: true,
        server,
        path: 'ssh://' + server + joinRemotePath(basePath, name)
      })
    );

    // DOUBLE-CLICKING a remote file still copies its name into the active chat
    // box (same behaviour as LOCAL file rows). A double-click also fires the
    // click handler above, so the row is selected as well.
    row.title = 'Click to select, double-click to insert this file name into the chat box';
    row.addEventListener('dblclick', () => {
      if (insertToChatHandler) insertToChatHandler(name);
    });

    // RIGHT-CLICKING a remote file selects it and opens the same two-item
    // context menu as a LOCAL file. Both verdicts are computed by the MAIN
    // process: previewing an image works over SFTP, so 'View' is offered for
    // whitelisted image names exactly as it is locally.
    row.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      markSelected(row, key, {
        dir: basePath,
        name,
        type: 'file',
        remote: true,
        server,
        path: 'ssh://' + server + joinRemotePath(basePath, name)
      });

      // Remote editing runs over SFTP in the main process. Unlike LOCAL files,
      // no extension whitelist applies here: the head-of-file byte sniff alone
      // (isProbablyTextBuffer over the first bytes fetched through the SFTP
      // connection) decides whether the item is enabled, so remote text files
      // with no extension or an unlisted one (Makefile, .gitignore, README, ...)
      // stay editable while binaries are still refused. isRemote tells the save
      // path to refresh the listing afterwards, since ssh:// folders are not
      // watched. The 'View' verdict needs no connection at all: it is decided
      // from the file name alone, so the menu still appears instantly.
      const remotePath = 'ssh://' + remoteServerName + joinRemotePath(basePath, name);
      const modelName = currentModelName ?? undefined;
      const axle = getAxle();
      if (!axle) {
        const reason = 'The application bridge is not ready.';
        openFileContextMenu({
          event: e,
          filePath: remotePath,
          fileName: name,
          editable: false,
          reason: 'Editing is unavailable: ' + reason,
          viewable: false,
          viewReason: 'Preview is unavailable: ' + reason,
          isRemote: true
        });
        return;
      }

      const editCheck =
        typeof axle.canEditFile === 'function'
          ? axle.canEditFile(remotePath, modelName)
          : Promise.resolve({
              editable: false,
              reason: 'Editing is unavailable: the application bridge is not ready.'
            });
      const viewCheck =
        typeof axle.canViewFile === 'function'
          ? axle.canViewFile(remotePath, modelName)
          : Promise.resolve({
              viewable: false,
              reason: 'Preview is unavailable: the application bridge is not ready.'
            });

      void Promise.all([editCheck, viewCheck])
        .then(([verdict, preview]) => {
          openFileContextMenu({
            event: e,
            filePath: remotePath,
            fileName: name,
            editable: Boolean(verdict && verdict.editable),
            reason: (verdict && verdict.reason) || '',
            viewable: Boolean(preview && preview.viewable),
            viewReason: (preview && preview.reason) || '',
            isRemote: true
          });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          openFileContextMenu({
            event: e,
            filePath: remotePath,
            fileName: name,
            editable: false,
            reason: message,
            viewable: false,
            viewReason: message,
            isRemote: true
          });
        });
    });

    container.appendChild(row);
  }

  // Restore previously-expanded remote sub-directories: re-open them and re-list
  // their content so a poll-driven re-render refreshes the current remote
  // directory AND all of its expanded sub-directories, while collapsed ones stay
  // untouched.
  for (const fr of remoteFolderRows) {
    if (expandedDirs.has(dirKey('remote', fr.childPath, server))) {
      fr.reveal();
    }
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
    // Remember what the listing shows: new entries are created inside the
    // resolved remote directory and the toolbar is enabled from this state.
    currentKind = 'remote';
    currentRemoteDir = info.path || '';

    if (!axle || typeof axle.listRemoteDir !== 'function') {
      currentRemoteDir = '';
      updateActionButtons();
      setDisplayedPath('ssh://' + info.serverName + info.path);
      showHint('Remote listing is unavailable: the application bridge is not ready.');
      return;
    }

    const resolved = await renderRemoteDir(bodyEl, info.serverName, info.path || '');
    // Drop the result if a newer load started while we awaited.
    if (token !== loadToken) return;

    // New entries are created inside the RESOLVED directory (the server may
    // have expanded '~' or a relative path), so track it now.
    currentRemoteDir = resolved;
    updateActionButtons();

    // Show the resolved remote path in the editable path box.
    setDisplayedPath('ssh://' + info.serverName + resolved);
    return;
  }

  // Local working directory: list folders AND files via the listEntries bridge.
  remoteServerName = '';
  rootPath = info.path || '';
  // New entries are created inside this directory and the toolbar is enabled
  // from this state, so record it before the listing is drawn.
  currentKind = 'local';
  currentRemoteDir = '';
  setDisplayedPath(rootPath);
  updateActionButtons();

  if (!rootPath) {
    showHint('No working directory set.');
    return;
  }

  await renderDir(bodyEl, rootPath);
  updateActionButtons();
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

  // Remember the card: the right-click context menu is absolutely positioned
  // against it and removed together with it (see openFileContextMenu).
  cardEl = root;

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

  // ---- File actions (right of the Refresh button) ----
  //
  // New File / New Folder create entries inside the directory currently shown.
  // There is no text box for them: the name is asked for in an inline modal,
  // because window.prompt() does not exist in Electron. Copy File and Delete
  // act on the SELECTED row, so they stay disabled until something is selected.
  // All four reuse the .files-refresh class so they look exactly like Refresh,
  // and every one of them works for LOCAL and REMOTE listings alike: the
  // renderer only builds the path, main does the work (over the cached SSH
  // connection for ssh:// targets).
  const makeActionButton = (
    iconPath: string,
    title: string,
    onClick: () => void
  ): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.className = 'files-refresh';
    btn.title = title;
    // The shared class centres a single text glyph; an inline SVG needs flex
    // centring as well so the icon sits exactly where the \u21bb does.
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    // The icons are drawn at 18px so their box matches the neighbouring
    // Refresh glyph (font-size: 18px on .files-refresh, workingDir.css). At
    // 14px they looked undersized beside it. The 16x16 viewBox scales cleanly,
    // and 28 - 18 still leaves 5px of padding per side inside the button.
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" ' +
      'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      iconPath +
      '</svg>';
    btn.addEventListener('click', () => onClick());
    pathRow.appendChild(btn);
    return btn;
  };

  const newFileBtn = makeActionButton(
    // A page with a '+' in its corner.
    '<path d="M9 1.6H4.3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1V5.6z"/>' +
      '<path d="M9 1.6v4h3.7"/>' +
      '<path d="M8 8.2v3.4M6.3 9.9h3.4"/>',
    'New file in this directory',
    () => void createEntry('file')
  );

  const newFolderBtn = makeActionButton(
    // A folder with a '+' inside.
    '<path d="M1.6 12.7V3.9a1 1 0 0 1 1-1h3.1l1.4 1.8h6.3a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z"/>' +
      '<path d="M8 7.3v3.2M6.4 8.9h3.2"/>',
    'New folder in this directory',
    () => void createEntry('folder')
  );

  const copyFileBtn = makeActionButton(
    // Two overlapping pages.
    '<path d="M5.7 1.6h4.1l2.5 2.5v7.3a1 1 0 0 1-1 1H5.7a1 1 0 0 1-1-1V2.6a1 1 0 0 1 1-1z"/>' +
      '<path d="M9.8 1.6v2.7h2.5"/>' +
      '<path d="M3.1 4.7v9.1a1 1 0 0 0 1 1h5.9"/>',
    'Copy the selected file or folder',
    () => void copySelectedEntry()
  );

  // Paste sits immediately right of Copy. It creates a copy of what Copy last
  // captured INSIDE the directory on screen, so the same pair of buttons works
  // for every combination: within one folder, across folders, and between a
  // local directory and a server (local -> remote and remote -> local). An
  // existing entry is never overwritten; main stores the copy under the next
  // free name. Disabled until something has been copied (updateActionButtons).
  const pasteBtn = makeActionButton(
    // A clipboard: the clip tab plus the board beneath it.
    '<path d="M6.1 1.6h3.8v2.2H6.1z"/>' +
      '<path d="M3.9 3.2H3.1a1 1 0 0 0-1 1v9.2a1 1 0 0 0 1 1h9.8a1 1 0 0 0 1-1V4.2a1 1 0 0 0-1-1h-.8"/>',
    'Paste the copied file or folder here',
    () => void pasteClipboard()
  );

  const deleteBtn = makeActionButton(
    // A bin with a lid.
    '<path d="M2.4 4.3h11.2"/>' +
      '<path d="M5.3 4.3V2.9a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v1.4"/>' +
      '<path d="M3.9 4.3l.7 9a1 1 0 0 0 1 1h4.9a1 1 0 0 0 1-1l.7-9"/>',
    'Delete the selected file or folder',
    () => void deleteSelectedEntry()
  );

  actionButtons = {
    newFile: newFileBtn,
    newFolder: newFolderBtn,
    copyFile: copyFileBtn,
    paste: pasteBtn,
    deleteEntry: deleteBtn
  };
  // Nothing is selected and no directory is known yet: start disabled.
  updateActionButtons();

  // Scrollable list (mirrors the dialog's .dir-dialog-list).
  bodyEl = document.createElement('div');
  bodyEl.className = 'files-card-list';
  body.appendChild(bodyEl);

  root.appendChild(body);
  ctx.container.appendChild(root);

  // No filesystem-change subscription is needed: refresh is driven by the
  // background poll loop (startPolling), which covers LOCAL and REMOTE folders
  // alike and is started as soon as a directory is rendered.

  // Load the listing immediately.
  void loadRoot();

  // The OS clipboard can change while this view is open (the user copies a file
  // in Explorer/Finder), so re-probe it whenever the window regains focus and
  // once now, to enable Paste for files that are already copied.
  if (!clipboardFocusHandler) {
    clipboardFocusHandler = () => {
      void probeClipboardCount();
    };
    window.addEventListener('focus', clipboardFocusHandler);
  }
  void probeClipboardCount();

  return {
    el: root,
    refresh: () => void loadRoot(),
    dispose: () => {
      // Drop any open context menu and its dismiss listeners before teardown,
      // and forget the card element the menu was parented to.
      closeFileContextMenu();
      cardEl = null;

      // Stop the background refresh loop and drop every tracked directory and
      // cached signature so no timer or listing work is left running after the
      // tab closes (clearDirTracking calls stopPolling).
      clearDirTracking();

      bodyEl = null;
      pathInputEl = null;

      // Drop the OS-clipboard focus probe so a closed tab leaves no listener
      // behind (the window outlives this view).
      if (clipboardFocusHandler) {
        window.removeEventListener('focus', clipboardFocusHandler);
        clipboardFocusHandler = null;
      }
      systemClipboardCount = 0;
      // Drop the toolbar references: they point at DOM that is being removed, and
      // a rebuilt view creates its own buttons.
      actionButtons = null;
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

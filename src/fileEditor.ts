/**
 * fileEditor.ts - the modal code editor opened from the 'Files' tab.
 *
 * Hosts Monaco, the editor VS Code is built on, in an overlay dialog sized to
 * about half of the window. The dialog is source-agnostic: the caller passes
 * the display name, the initial text and a save callback, so the same dialog
 * can serve local files, remote files or any future source.
 *
 * Bundling: monaco-editor is imported through its package entry and pruned and
 * emitted by MonacoWebpackPlugin (see webpack.renderer.config.ts). The plugin
 * also produces the language workers, which the editor loads from blob: URLs.
 * The application sets no Content-Security-Policy (neither a meta tag in
 * src/index.html nor a header in src/main.ts), so those workers are allowed.
 *
 * Presentation lives in src/workingDir.css (.file-editor*).
 */

import * as monaco from 'monaco-editor';
import { buildPathBox } from './pathBox';
import type { PathBoxHandle } from './pathBox';

/** What a save callback must resolve with. */
export interface FileEditorSaveResult {
  ok: boolean;
  error?: string;
}

/** Options accepted by openFileEditor. */
export interface FileEditorOptions {
  /** Display name shown in the dialog header (for example renderer.ts). */
  fileName: string;
  /** Full path of the file; shown under the title and passed to save. */
  filePath: string;
  /** Initial text placed in the editor. */
  content: string;
  /**
   * The text `content` was last PERSISTED as, when the incoming buffer already
   * carries edits that are not on disk yet.
   *
   * A dirty check compares `content` against this baseline. Omitted - the usual
   * case - the baseline IS `content`, so the dialog opens clean because the
   * caller handed over exactly what was saved.
   *
   * The view space passes it when it re-hosts a tab's LIVE buffer in a floating
   * dialog: the buffer there already includes the user's unsaved edits, and
   * without this baseline the dialog would consider itself up to date, disable
   * Save and give the user no way to persist those edits from the dialog.
   */
  savedContent?: string;
  /** Explicit Monaco language id; inferred from fileName when omitted. */
  language?: string;
  /**
   * Persist the edited text. Resolve with { ok: false, error } (or throw) to
   * report a failure; the dialog then stays open with the message shown.
   *
   * OPTIONAL: it is omitted for a VIEW-ONLY dialog, where nothing is persisted
   * and no Save button is rendered.
   */
  save?: (content: string) => Promise<FileEditorSaveResult>;
  /**
   * Open the dialog VIEW-ONLY. Monaco refuses edits, the Save button is not
   * mounted and Ctrl/Cmd+S is not bound, so the same editor can render a text
   * file for reading (the Files tab's 'View' item) without any way to modify
   * it. The close paths never prompt, because a read-only buffer is never
   * dirty.
   */
  readOnly?: boolean;
  /**
   * Mount WITHOUT the modal chrome: no dimmed backdrop, no backdrop
   * dismissal, no Escape-to-close, no resize grip, no maximize button, no
   * title bar and no footer action buttons (Close/Cancel and Save).
   * The dialog box itself (path line, editor surface and a transient
   * save-status line) is rendered into `parent` as an ordinary block
   * element, which is how the view space in src/viewSpace.ts embeds this
   * same Monaco editor inside a tab panel instead of a floating window.
   *
   * An embedded instance therefore has no header and no footer buttons: it
   * is closed through its view-space tab, which routes through `requestClose`
   * (so a dirty buffer still asks before discarding), and the host is told
   * through `onClose` so it can drop the owning tab. Saving stays available
   * on Ctrl/Cmd+S and reports 'Saving...' / 'Saved' / errors on the status
   * line, which is the only part of the footer that is kept.
   */
  embedded?: boolean;
  /**
   * Called exactly once, after the editor has disposed itself and been
   * detached from the DOM. Never called for a close that was cancelled on a
   * dirty buffer, because nothing was disposed in that case.
   *
   * Used by the view space to remove the tab that owned this instance.
   */
  onClose?: () => void;
  /**
   * Called whenever the buffer becomes dirty or clean, but only on a CHANGE
   * (a no-op refresh does not fire it).
   *
   * An embedded instance renders no title bar, so the dot that normally marks
   * unsaved changes has nowhere to live; this callback lets the host (the view
   * space) paint that signal on its own tab instead. A throwing callback is
   * contained, so it can never break the editor.
   *
   * Ignored by a view-only instance, which reports false exactly once.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Called after a save SUCCEEDED, with the text that was just persisted.
   *
   * More than one editor can show the same file - the view space keeps a tab
   * open while its floating dialog is the one doing the saving - and the two
   * hold INDEPENDENT Monaco buffers. Without this notification only the saving
   * editor would learn that the text reached disk: the other would keep
   * comparing its own buffer against the pre-save baseline, stay marked dirty
   * and prompt to discard edits that were already written.
   *
   * The receiving editor adopts the text through FileEditorHandle.markSaved.
   * A throwing callback is contained, so it can never turn a completed save
   * into an error.
   *
   * Ignored by a view-only instance, which has no save path at all.
   */
  onSaved?: (content: string) => void;
  /** Optional mount point; defaults to document.body. */
  parent?: HTMLElement;
}

/** Live handle returned by openFileEditor. */
export interface FileEditorHandle {
  /** The overlay element (already attached to the DOM). */
  el: HTMLElement;
  /** Dispose the editor and remove the dialog (asks before discarding edits). */
  close: () => void;
  /** True while the buffer differs from the last saved text. */
  isDirty: () => boolean;
  /**
   * The LIVE text currently held by the editor, read straight from the
   * Monaco model instead of the `content` string this instance was opened
   * with.
   *
   * The two differ as soon as the user types: `content` is only the INITIAL
   * snapshot, while this getter describes the buffer as it is right now
   * (saved or not). A host that re-hosts the same buffer somewhere else - the
   * view space hands it to a floating dialog when the user presses 'open in a
   * modal dialog' - must therefore use this getter, or the new dialog would
   * show the file as it looked when the tab was opened and silently lose
   * every edit made since.
   *
   * Returns '' after the editor has been disposed, so a stale handle can never
   * throw on a disposed Monaco model.
   */
  getContent: () => string;
  /**
   * The text the LIVE buffer was last PERSISTED as - its dirty baseline.
   *
   * The counterpart of `getContent`: together they let a host pass this buffer
   * on WITHOUT losing its unsaved state. The view space reads both when the
   * user toggles a tab into a floating dialog, so the new dialog receives the
   * current text as `content` and this value as `savedContent` and therefore
   * opens dirty, with Save enabled, exactly like the tab it came from.
   *
   * Returns '' after the editor has been disposed.
   */
  getSavedContent: () => string;
  /**
   * Adopt a text another editor PERSISTED for the same file.
   *
   * The receiving end of FileEditorOptions.onSaved. More than one editor can
   * show one file at a time - a view-space tab plus the floating dialog it was
   * toggled into - and they hold INDEPENDENT Monaco buffers, so a save in the
   * dialog does not touch the tab on its own. Calling this with the saved text
   * makes this editor adopt it as its baseline (and as its buffer, when the two
   * differ), which clears the unsaved marker and the discard prompt on the
   * close path.
   *
   * Does nothing once the editor has been disposed.
   */
  markSaved: (content: string) => void;
}

/**
 * Extension (lower-case, leading dot) to Monaco language id. Extensions that
 * carry no dedicated grammar are mapped to plaintext explicitly.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.dtd': 'xml',
  '.xsd': 'xml',
  '.sql': 'sql',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.ini': 'ini',
  '.toml': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.properties': 'ini'
};

/**
 * Pure-prose / log / delimiter-separated extensions: shown without a grammar
 * so Monaco does not impose a misleading syntax highlighting.
 */
const PLAIN_TEXT_EXTENSIONS = new Set<string>([
  '.txt', '.text', '.log', '.csv', '.tsv', '.env', '.rst', '.nfo',
  '.list', '.diff', '.patch'
]);

/** Lower-cased extension of a file name, including the leading dot. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return '';
  return fileName.slice(dot).toLowerCase();
}

/** Monaco language id inferred from a file name (fallback plaintext). */
export function monacoLanguageFor(fileName: string): string {
  const ext = extensionOf(fileName);
  if (!ext) return 'plaintext';
  if (PLAIN_TEXT_EXTENSIONS.has(ext)) return 'plaintext';
  return LANGUAGE_BY_EXTENSION[ext] || 'plaintext';
}

/**
 * Open the modal code editor and return a handle that disposes it.
 *
 * The dialog is appended to the given parent (document.body by default) and
 * closes on Escape, the close button, Cancel, or a click on the dimmed
 * backdrop. While the buffer is dirty those paths confirm first so edits are
 * never lost silently, and Ctrl/Cmd+S saves without leaving the dialog.
 */
export function openFileEditor(options: FileEditorOptions): FileEditorHandle {
  const parent = options.parent || document.body;

  // ---- DOM skeleton ----
  // An EMBEDDED instance (mounted by the view space) is an ordinary block
  // inside its host panel: the wrapper carries no dimming/backdrop styling and
  // the box is not announced as a modal dialog, because it does not block the
  // rest of the UI. Every guard below keys off this single flag.
  const embedded = options.embedded === true;

  const overlay = document.createElement('div');
  overlay.className = embedded ? 'file-editor-embed' : 'file-editor-overlay';

  const dialog = document.createElement('div');
  dialog.className = embedded ? 'file-editor file-editor-inline' : 'file-editor';
  if (!embedded) {
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
  }

  const header = document.createElement('div');
  header.className = 'file-editor-header';

  const title = document.createElement('span');
  title.className = 'file-editor-title';
  title.textContent = options.fileName;
  title.title = options.filePath;

  const dirtyDot = document.createElement('span');
  dirtyDot.className = 'file-editor-dirty hidden';
  dirtyDot.textContent = '●';
  dirtyDot.title = 'Unsaved changes';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'file-editor-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  // An embedded instance ignores Escape (the host window owns the keyboard),
  // so the tooltip must not advertise a shortcut that does nothing.
  closeBtn.title = embedded ? 'Close' : 'Close (Esc)';

  // Maximize / restore toggle, placed left of the close button. The two icons
  // are inline SVG so the states swap without an icon font, and currentColor
  // keeps them in step with the hover colour set in workingDir.css. This is the
  // same control src/imageViewer.ts puts in its header.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_MAXIMIZE = ['M2.5 6V2.5H6', 'M10 2.5h3.5V6', 'M13.5 10v3.5H10', 'M6 13.5H2.5V10'];
  const ICON_RESTORE = ['M5.5 5.5h8v8h-8z', 'M10.5 10.5v3h-8v-8h3'];

  const buildIcon = (paths: string[]): SVGSVGElement => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    }
    return svg;
  };

  const maxBtn = document.createElement('button');
  maxBtn.className = 'file-editor-max';
  maxBtn.type = 'button';

  header.appendChild(title);
  header.appendChild(dirtyDot);
  // The maximize/restore toggle only makes sense for the floating dialog: an
  // embedded instance is already pinned inside its view-space panel, so the
  // control is not mounted and onToggleMaximize is never wired below.
  if (!embedded) header.appendChild(maxBtn);
  header.appendChild(closeBtn);

  // The path line is the SHARED searchable path box (src/pathBox.ts) - the same
  // control the view-space tab bar and the image preview render - so the file
  // path looks and behaves identically on every surface. `pathLine` stays an
  // alias for the box's root element, which keeps every appendChild / geometry
  // reference below unchanged (the dialog's own flex column is untouched).
  const pathBox: PathBoxHandle = buildPathBox({
    path: options.filePath,
    className: 'path-box-inline'
  });
  const pathLine = pathBox.el;

  const surface = document.createElement('div');
  surface.className = 'file-editor-surface';

  const footer = document.createElement('div');
  footer.className = 'file-editor-footer';

  const status = document.createElement('span');
  status.className = 'file-editor-status';

  // A VIEW-ONLY dialog has nothing to persist, so its only button CLOSES and
  // the header says so. The Save element is still created (the dirty/save
  // bookkeeping below references it) but it is never appended to the footer.
  const viewOnly = options.readOnly === true;

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'file-editor-btn';
  cancelBtn.type = 'button';
  cancelBtn.textContent = viewOnly ? 'Close' : 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'file-editor-btn primary';
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.title = 'Save (Ctrl+S)';

  footer.appendChild(status);
  // The footer ACTIONS belong to the floating dialog. An embedded instance
  // is closed by its view-space tab and saved with Ctrl/Cmd+S, so mounting
  // Close/Cancel and Save would only repeat controls the host already owns.
  // The buttons are still created above (the same create-but-do-not-append
  // pattern viewOnly uses for Save) so doSave and refreshDirty keep valid
  // references; they are simply never attached here. What remains is the
  // status span, and the row starts hidden so an empty status cannot paint a
  // stray strip - setStatus reveals it only while there is something to say.
  if (!embedded) {
    footer.appendChild(cancelBtn);
    if (!viewOnly) footer.appendChild(saveBtn);
  } else {
    footer.classList.add('hidden');
  }

  if (viewOnly) {
    title.title = options.filePath + ' (read-only)';
    title.textContent = options.fileName;
  }

  // Bottom-right grip that makes the dialog resizable with the mouse. It is an
  // absolutely positioned child of the dialog (see .file-editor-resize), so it
  // overlays the footer corner without taking part in the flex column. The
  // gesture itself is wired in onGripMouseDown and mirrors the image viewer's
  // grip plus makeResizable in src/rightWorkspace.ts.
  // The grip belongs to the floating dialog only: an embedded instance is
  // sized by the view-space resizer, so the corner grip is skipped entirely.
  const resizeGrip = document.createElement('div');
  resizeGrip.className = 'file-editor-resize';
  resizeGrip.title = 'Drag to resize';

  // The TITLE BAR is not part of an embedded instance. The view-space tab
  // already shows the file name and its own close marker, so a header would
  // spend a whole row repeating both. The path line and the editor surface
  // are kept, and the footer keeps ONLY its transient save-status line: the
  // Close/Cancel and Save buttons are dialog-only, because the tab closes the
  // file and Ctrl/Cmd+S saves it. The unsaved-changes signal (whose dot lives
  // in the skipped header) is reported to the host through
  // options.onDirtyChange instead.
  if (!embedded) dialog.appendChild(header);
  dialog.appendChild(pathLine);
  dialog.appendChild(surface);
  dialog.appendChild(footer);
  if (!embedded) dialog.appendChild(resizeGrip);
  overlay.appendChild(dialog);
  parent.appendChild(overlay);

  // ---- Editor ----
  const model = monaco.editor.createModel(
    options.content,
    options.language || monacoLanguageFor(options.fileName)
  );

  const editor = monaco.editor.create(surface, {
    model,
    theme: 'vs-dark',
    // A view-only dialog must REFUSE edits, not merely fail to save them.
    readOnly: viewOnly,
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'Consolas, Courier New, monospace',
    lineNumbers: 'on',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    tabSize: 2,
    wordWrap: 'off',
    fixedOverflowWidgets: true
  });

  // ---- State ----
  // The baseline the dirty check compares against. Normally the text this
  // editor was opened with; a caller that hands over a buffer whose edits are
  // not on disk yet (the view space re-hosting a dirty tab) also passes that
  // file's last SAVED text, so the dialog opens dirty and Save stays clickable.
  let savedText =
    typeof options.savedContent === 'string' ? options.savedContent : options.content;
  let dirty = false;
  let saving = false;
  let closed = false;
  // True while the dialog is pinned to the work area. Only the header's
  // maximize button touches this; the stylesheet owns the geometry (see
  // .file-editor.maximized in workingDir.css).
  let maximized = false;

  // ---- Drag to resize ----
  // Minimums mirror .file-editor in workingDir.css so a drag can never shrink
  // the dialog below the size the stylesheet allows. DIALOG_MARGIN keeps that
  // much gap to the window edges, matching the image viewer.
  const MIN_DIALOG_W = 520;
  const MIN_DIALOG_H = 320;
  const DIALOG_MARGIN = 24;

  // Last size the user dragged to. Remembered so restoring from maximized puts
  // the dialog back where it was instead of at the stylesheet default.
  let userWidth = 0;
  let userHeight = 0;

  // Active drag gesture state (see onGripMouseDown).
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // Last dirty value the host was told about, so the callback fires on a
  // CHANGE only. An embedded instance has no title bar, which is where the
  // dot used to live, so the host repaints its own tab marker instead.
  let lastReportedDirty = false;

  const notifyDirty = (): void => {
    if (dirty === lastReportedDirty) return;
    lastReportedDirty = dirty;
    if (!options.onDirtyChange) return;
    try {
      options.onDirtyChange(dirty);
    } catch (error) {
      // A host that throws must not break the editor's own bookkeeping.
      console.error('[fileEditor] onDirtyChange handler failed', error);
    }
  };

  const refreshDirty = (): void => {
    // A view-only buffer cannot be modified, so it is never dirty: keeping the
    // flag false also means the close paths never ask to discard anything.
    if (viewOnly) {
      dirty = false;
      if (!embedded) dirtyDot.classList.add('hidden');
      saveBtn.disabled = true;
      notifyDirty();
      return;
    }
    const value = model.getValue();
    dirty = value !== savedText;
    // The dot lives in the title bar, which an embedded instance does not
    // render; the host is told through onDirtyChange instead. saveBtn is
    // updated in both modes even though an embedded instance never mounts it
    // (Ctrl/Cmd+S saves there), which keeps the bookkeeping in one place.
    if (!embedded) dirtyDot.classList.toggle('hidden', !dirty);
    saveBtn.disabled = saving || !dirty;
    notifyDirty();
  };

  const setStatus = (text: string, isError: boolean): void => {
    status.textContent = text;
    status.className = isError ? 'file-editor-status error' : 'file-editor-status';
    // With the action buttons gone, an embedded footer that says nothing
    // would still paint its padding and top border as an empty strip, so the
    // row is hidden while the text is empty and shown again for 'Saving...',
    // 'Saved' and save errors. The floating dialog keeps its footer visible
    // at all times, because its buttons live there.
    if (embedded) footer.classList.toggle('hidden', text.length === 0);
  };

  const changeSub = model.onDidChangeContent(() => {
    if (closed) return;
    refreshDirty();
    if (!saving) setStatus('', false);
  });

  // ---- Lifecycle ----
  const disposeAll = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    overlay.removeEventListener('mousedown', onOverlayMouseDown);
    maxBtn.removeEventListener('click', onToggleMaximize);
    // Drag listeners live on window while a gesture is active, so they are
    // detached here too: closing mid-drag must not leave a handler pointing at
    // a removed dialog. Removing absent listeners is a no-op.
    resizeGrip.removeEventListener('mousedown', onGripMouseDown);
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    // An interrupted drag may still have text selection suppressed.
    document.body.style.userSelect = '';
    changeSub.dispose();
    // The path box owns a document-level mousedown listener (to leave search
    // mode on an outside click) and a debounce timer, so it is disposed with
    // the dialog rather than left attached to a removed element.
    pathBox.dispose();
    editor.dispose();
    model.dispose();
    overlay.remove();
    // Tell the host only AFTER the DOM is gone, so a view-space tab is never
    // dropped while its editor is still half-disposed. A throwing callback must
    // not turn a completed close into an error, so it is contained here.
    if (options.onClose) {
      try {
        options.onClose();
      } catch (error) {
        console.error('[fileEditor] onClose handler failed', error);
      }
    }
  };

  const requestClose = (): void => {
    if (saving) return;
    if (dirty && !window.confirm('Discard unsaved changes to ' + options.fileName + '?')) {
      return;
    }
    disposeAll();
  };

  // ---- Drag to resize ----
  // Mirrors makeResizable in src/rightWorkspace.ts: the gesture runs on
  // window-level mousemove/mouseup so it survives the pointer leaving the
  // 16px grip, only the primary button starts it, and text selection is
  // suppressed for the duration. A maximized dialog is pinned by the
  // stylesheet, so the grip is inert (and hidden) in that mode.
  function onGripMouseDown(e: MouseEvent): void {
    if (closed || maximized || e.button !== 0) return;
    // Distance from the pointer to the dialog's bottom-right edge, so the
    // corner keeps following the pointer instead of snapping to it.
    dragOffsetX = e.clientX - dialog.offsetWidth;
    dragOffsetY = e.clientY - dialog.offsetHeight;
    document.body.style.userSelect = 'none';
    dialog.classList.add('resizing');
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    e.preventDefault();
  }

  function onDragMove(e: MouseEvent): void {
    if (closed) return;
    const maxW = Math.max(MIN_DIALOG_W, window.innerWidth - DIALOG_MARGIN * 2);
    const maxH = Math.max(MIN_DIALOG_H, window.innerHeight - DIALOG_MARGIN * 2);
    const width = Math.min(Math.max(e.clientX - dragOffsetX, MIN_DIALOG_W), maxW);
    const height = Math.min(Math.max(e.clientY - dragOffsetY, MIN_DIALOG_H), maxH);
    userWidth = Math.round(width);
    userHeight = Math.round(height);
    dialog.style.width = userWidth + 'px';
    dialog.style.height = userHeight + 'px';
    // Monaco is created with automaticLayout, so it re-measures by itself as
    // the box changes; calling layout() on every mousemove would only add work.
  }

  function onDragEnd(): void {
    if (closed) return;
    document.body.style.userSelect = '';
    dialog.classList.remove('resizing');
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    // One explicit re-measure at the end keeps the final size exact even if
    // automaticLayout's observer has not fired yet.
    editor.layout();
  }

  // Pin the dialog to the work area and back. The stylesheet owns both
  // geometries (.file-editor vs .file-editor.maximized); this handler only
  // flips the class and keeps the button describing what a click does next.
  function onToggleMaximize(): void {
    maximized = !maximized;
    dialog.classList.toggle('maximized', maximized);

    // A dragged inline size would beat the stylesheet's .maximized geometry,
    // so it is dropped while pinned and re-applied on restore, putting the
    // dialog back exactly where the user left it.
    if (maximized) {
      dialog.style.width = '';
      dialog.style.height = '';
    } else if (userWidth > 0 && userHeight > 0) {
      dialog.style.width = userWidth + 'px';
      dialog.style.height = userHeight + 'px';
    }

    maxBtn.textContent = '';
    maxBtn.appendChild(buildIcon(maximized ? ICON_RESTORE : ICON_MAXIMIZE));
    const label = maximized ? 'Restore size' : 'Maximize to screen';
    maxBtn.title = label;
    maxBtn.setAttribute('aria-label', label);
    maxBtn.setAttribute('aria-pressed', maximized ? 'true' : 'false');

    // automaticLayout already tracks the box, but asking for a layout makes the
    // re-measure deterministic instead of waiting for Monaco's next frame.
    editor.layout();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    requestClose();
  }

  function onOverlayMouseDown(e: MouseEvent): void {
    if (e.target === overlay) requestClose();
  }

  // ---- Save ----
  const doSave = async (): Promise<void> => {
    // View-only dialogs are created without a save callback, so there is
    // nothing to persist and the function is a no-op for them.
    const save = options.save;
    if (!save || viewOnly) return;
    if (saving || closed) return;
    const value = model.getValue();
    if (value === savedText) return;

    saving = true;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    closeBtn.disabled = true;
    setStatus('Saving...', false);

    try {
      const result = await save(value);
      if (closed) return;
      if (result && result.ok) {
        savedText = value;
        // The text reached disk, so EVERY other editor showing this file must
        // adopt it: the view-space tab behind a toggled dialog holds its own
        // Monaco buffer and would otherwise keep its unsaved marker (and its
        // discard prompt) for edits that are already saved. Fired before the
        // status line and contained, so a throwing host cannot break saving.
        if (options.onSaved) {
          try {
            options.onSaved(value);
          } catch (error) {
            console.error('[fileEditor] onSaved handler failed', error);
          }
        }
        setStatus('Saved', false);
        window.setTimeout(() => {
          if (!closed && status.textContent === 'Saved') setStatus('', false);
        }, 1500);
      } else {
        setStatus((result && result.error) || 'Save failed', true);
      }
    } catch (error) {
      if (closed) return;
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      saving = false;
      if (!closed) {
        cancelBtn.disabled = false;
        closeBtn.disabled = false;
        refreshDirty();
      }
    }
  };

  // ---- External save ----
  // Adopt a text another editor persisted for the same file (see
  // FileEditorOptions.onSaved). The baseline moves to that text, and a buffer
  // that somehow diverged from it is replaced - a view-space tab whose content
  // was persisted from its toggled dialog is clean afterwards, so its unsaved
  // marker clears through refreshDirty -> notifyDirty and closing it no longer
  // asks to discard edits that are already on disk.
  const markSaved = (content: string): void => {
    if (closed) return;
    savedText = content;
    // A view-only buffer cannot legitimately differ, so it is never rewritten.
    if (!viewOnly && model.getValue() !== content) {
      // setValue fires onDidChangeContent, which refreshes the dirty state; the
      // explicit refreshDirty below covers the equal-content case too. The
      // change is announced as a normal edit, so the status line is cleared by
      // the same handler - which is what a save just did.
      model.setValue(content);
    }
    refreshDirty();
  };

  // ---- Wiring ----
  closeBtn.addEventListener('click', requestClose);
  // The footer actions exist only in the floating dialog, so an embedded
  // instance does not wire them: it saves through the Ctrl/Cmd+S command
  // below and is closed by its view-space tab through handle.close().
  if (!embedded) {
    cancelBtn.addEventListener('click', requestClose);
    saveBtn.addEventListener('click', () => { void doSave(); });
  }

  // Dialog-only wiring. An embedded instance has no backdrop to click, no grip
  // to drag and must not steal Escape from the surrounding window, so those
  // listeners are attached for the floating dialog alone.
  if (!embedded) {
    maxBtn.appendChild(buildIcon(ICON_MAXIMIZE));
    maxBtn.title = 'Maximize to screen';
    maxBtn.setAttribute('aria-label', 'Maximize to screen');
    maxBtn.setAttribute('aria-pressed', 'false');
    maxBtn.addEventListener('click', onToggleMaximize);
    overlay.addEventListener('mousedown', onOverlayMouseDown);
    resizeGrip.addEventListener('mousedown', onGripMouseDown);
    window.addEventListener('keydown', onKeyDown, true);
  }

  // Ctrl/Cmd+S saves from inside the editor without leaving the dialog. A
  // view-only dialog has no save path at all, so the shortcut is not bound.
  if (!viewOnly) {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void doSave(); });
  }

  refreshDirty();
  editor.setPosition({ lineNumber: 1, column: 1 });
  editor.focus();

  return {
    el: overlay,
    close: requestClose,
    isDirty: () => dirty,
    // The LIVE buffer, not options.content: a host that re-hosts this text
    // (the view space opening it in a floating dialog) must see every edit
    // made since the editor was opened. Reading a disposed model would throw,
    // so a closed handle reports '' instead.
    getContent: () => (closed ? '' : model.getValue()),
    // The baseline that buffer is measured against, so a host re-hosting this
    // text can keep its unsaved state: handing both values to the next editor
    // makes it open dirty instead of pretending the edits were saved.
    getSavedContent: () => (closed ? '' : savedText),
    // The receiving end of FileEditorOptions.onSaved: the host forwards a save
    // performed by ANOTHER editor of the same file here, so this buffer adopts
    // it and stops reporting unsaved changes for text that already reached disk.
    markSaved
  };
}

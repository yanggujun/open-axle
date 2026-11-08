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
  /** Explicit Monaco language id; inferred from fileName when omitted. */
  language?: string;
  /**
   * Persist the edited text. Resolve with { ok: false, error } (or throw) to
   * report a failure; the dialog then stays open with the message shown.
   */
  save: (content: string) => Promise<FileEditorSaveResult>;
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
  const overlay = document.createElement('div');
  overlay.className = 'file-editor-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'file-editor';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

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
  closeBtn.title = 'Close (Esc)';

  header.appendChild(title);
  header.appendChild(dirtyDot);
  header.appendChild(closeBtn);

  const pathLine = document.createElement('div');
  pathLine.className = 'file-editor-path';
  pathLine.textContent = options.filePath;
  pathLine.title = options.filePath;

  const surface = document.createElement('div');
  surface.className = 'file-editor-surface';

  const footer = document.createElement('div');
  footer.className = 'file-editor-footer';

  const status = document.createElement('span');
  status.className = 'file-editor-status';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'file-editor-btn';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'file-editor-btn primary';
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save';
  saveBtn.title = 'Save (Ctrl+S)';

  footer.appendChild(status);
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  dialog.appendChild(header);
  dialog.appendChild(pathLine);
  dialog.appendChild(surface);
  dialog.appendChild(footer);
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
    readOnly: false,
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
  let savedText = options.content;
  let dirty = false;
  let saving = false;
  let closed = false;

  const refreshDirty = (): void => {
    const value = model.getValue();
    dirty = value !== savedText;
    dirtyDot.classList.toggle('hidden', !dirty);
    saveBtn.disabled = saving || !dirty;
  };

  const setStatus = (text: string, isError: boolean): void => {
    status.textContent = text;
    status.className = isError ? 'file-editor-status error' : 'file-editor-status';
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
    changeSub.dispose();
    editor.dispose();
    model.dispose();
    overlay.remove();
  };

  const requestClose = (): void => {
    if (saving) return;
    if (dirty && !window.confirm('Discard unsaved changes to ' + options.fileName + '?')) {
      return;
    }
    disposeAll();
  };

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
    if (saving || closed) return;
    const value = model.getValue();
    if (value === savedText) return;

    saving = true;
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    closeBtn.disabled = true;
    setStatus('Saving...', false);

    try {
      const result = await options.save(value);
      if (closed) return;
      if (result && result.ok) {
        savedText = value;
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

  // ---- Wiring ----
  closeBtn.addEventListener('click', requestClose);
  cancelBtn.addEventListener('click', requestClose);
  saveBtn.addEventListener('click', () => { void doSave(); });
  overlay.addEventListener('mousedown', onOverlayMouseDown);
  window.addEventListener('keydown', onKeyDown, true);

  // Ctrl/Cmd+S saves from inside the editor without leaving the dialog.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void doSave(); });

  refreshDirty();
  editor.setPosition({ lineNumber: 1, column: 1 });
  editor.focus();

  return {
    el: overlay,
    close: requestClose,
    isDirty: () => dirty
  };
}

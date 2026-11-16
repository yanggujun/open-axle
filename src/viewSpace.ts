/**
 * viewSpace.ts - the tabbed view space between the model chat and the right dock.
 *
 * The area (#view-space in src/index.html) stays hidden until a file is asked
 * for; from then on every VIEW/EDIT request lands here instead of in a modal
 * dialog. It hosts ONE TAB PER OPEN FILE and only ever renders the two kinds of
 * file it can draw:
 *
 *   - text/code  -> fileEditor.ts (Monaco) in its embedded mode;
 *   - image      -> imageViewer.ts in its embedded mode.
 *
 * Both modules are the same ones the modal dialogs use; embedded merely drops
 * the backdrop, the Escape/backdrop dismissal and the resize grip/maximize
 * controls, which belong to a floating window. Anything that is neither text nor
 * an image is refused here so the caller can fall back to its old path.
 *
 * The header carries the tab strip and, immediately LEFT of the close button, a
 * ONE-SHOT action that re-opens the ACTIVE file in a floating modal dialog. It
 * holds no state: every View/Edit request opens here regardless of how often
 * that button has been clicked, and the button is never pressed or highlighted.
 *
 * That action hands the dialog the tab's LIVE buffer, not the text the tab was
 * opened with: the file may have been edited in place since, and a toggle that
 * showed the open-time snapshot would silently drop those edits (see openModal).
 *
 * The left-edge grip resizes the area horizontally, mirroring #right-workspace.
 *
 * NOTE: this is RENDERER code, so it must not import src/common/common.ts: that
 * module imports fs and ssh2. The extension tables below therefore mirror the
 * classifier in common.ts (isTextFile / isImageFile / fileViewKind) by hand -
 * keep the two in step when a new extension becomes viewable.
 */

import { openFileEditor } from './fileEditor';
import { buildPathBox, setPathBoxOpenHandler } from './pathBox';
import type { PathBoxHandle } from './pathBox';
import type { FileEditorSaveResult } from './fileEditor';
import { openImageViewer } from './imageViewer';

// ---------------------------------------------------------------------------
// Renderer bridge used by the file path box
// ---------------------------------------------------------------------------

/**
 * The subset of window.axle the path box needs.
 *
 * Declared here, exactly like FilesBridge in src/filesTab.ts, so this renderer
 * module stays free of imports from src/common/common.ts: that module pulls in
 * fs and ssh2, which a sandboxed renderer must never load.
 */
interface ViewSpaceBridge {
  // NOTE: `findFiles` used to be declared here. It moved to src/pathBox.ts
  // (PathBoxBridge) when the searchable path box became ONE shared control: the
  // box mounted by this area, by the code editor and by the image preview is
  // the same object, so exactly one module owns the query and its base
  // directory. What stays here are the two READ methods openSearchResult still
  // needs after a match is picked.
  /** Read a file as RAW text (no code fence) so a view-only tab can show it. */
  readFileRaw(
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; content?: string; error?: string; }>;
  /** Read an image as base64 plus its MIME type so a data: URI can be built. */
  readImageFile(
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; base64?: string; mimeType?: string; error?: string; }>;
}

/** Read the bridge (it may be undefined during early startup). */
function getBridge(): Partial<ViewSpaceBridge> | undefined {
  return (window as unknown as { axle?: Partial<ViewSpaceBridge> }).axle;
}

// ---------------------------------------------------------------------------
// File path box: constants and state
// ---------------------------------------------------------------------------

/**
 * The SHARED searchable path box in this area's header (src/pathBox.ts).
 *
 * It is the SAME control the code editor's path line and the image preview's
 * path line mount: the active file's path, with a magnifier INSIDE the box on
 * its right that turns the box into a file-search field and, pressed again,
 * back into the plain non-editable path. The debounce, the query, the dropdown,
 * the keyboard handling and the "leave search mode on an outside click" rule all
 * live in that module, so this one only forwards the active path to it.
 *
 * Null until ensureDom() has resolved the markup.
 */
let pathBox: PathBoxHandle | null = null;

// NOTE: the directory-of-a-path helper moved into src/pathBox.ts, which now owns
// the search base directory (host callback, else the current file's directory,
// else the active model's working directory). baseNameOf below is still used by
// openSearchResult, so it stays.

/** Last path segment, used as the display name of a match. */
function baseNameOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut >= 0 ? filePath.slice(cut + 1) : filePath;
}

/** Which viewer a file needs. */
export type ViewFileKind = 'text' | 'image';

/** A file to show, with its payload already loaded by the caller. */
export interface ViewSpaceEntry {
  /** Full path; also the tab identity and the tooltip. */
  filePath: string;
  /** Display name shown on the tab and in the viewer header. */
  fileName: string;
  /** Viewer to use. Only 'text' and 'image' are accepted. */
  kind: ViewFileKind;
  /** Text files: open view-only instead of editable. */
  readOnly?: boolean;
  /** Text files: the initial buffer. */
  content?: string;
  /** Text files: persist the edited buffer (omitted for view-only tabs). */
  save?: (content: string) => Promise<FileEditorSaveResult>;
  /** Image files: MIME type and base64 payload. */
  mimeType?: string;
  base64?: string;
}

// ---------------------------------------------------------------------------
// Renderer-local mirror of the file classifier in src/common/common.ts
// ---------------------------------------------------------------------------

/** Extensions that carry no grammar but are still plain text (mirrors common). */
const PURE_TEXT_EXTENSIONS = new Set<string>([
  '.txt', '.text', '.log', '.csv', '.tsv', '.ini', '.cfg', '.conf',
  '.properties', '.env', '.toml', '.rst', '.nfo', '.list', '.diff', '.patch'
]);

/** Structured-text extensions handled as text rather than as images. */
const STRUCTURED_TEXT_EXTENSIONS = new Set<string>([
  '.json', '.xml', '.dtd', '.xsd', '.html', '.htm', '.css', '.md', '.markdown',
  '.yaml', '.yml', '.svg'
]);

/** Code extensions the text viewer can highlight. */
const CODE_EXTENSIONS = new Set<string>([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py',
  '.java', '.go', '.rs', '.rb', '.php', '.cs', '.kt', '.kts', '.swift',
  '.scala', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.scss', '.less'
]);

/** Raster image extensions: bytes that only a picture viewer can draw. */
const RASTER_IMAGE_EXTENSIONS = new Set<string>([
  '.png', '.apng', '.jpg', '.jpeg', '.jpe', '.jfif', '.gif', '.bmp',
  '.webp', '.tif', '.tiff', '.ico', '.cur', '.avif', '.heic', '.heif'
]);

/**
 * Extensions that are markup but that the main process ALSO serves as a
 * picture, because axl:readImageFile whitelists them (see main.ts,
 * IMAGE_VIEW_EXTRA_EXTENSIONS). SVG is the only member.
 *
 * An SVG is therefore BOTH things at once: its source is XML text Monaco can
 * edit, and its bytes are an image the preview viewer can draw. The caller's
 * requested kind decides which one it gets - see openInViewSpace.
 */
const PICTURE_ONLY_IMAGE_EXTENSIONS = new Set<string>(['.svg']);

/** Either path separator, so Windows and POSIX paths both work. */
const PATH_SEPARATOR = /[\\/]/;

/** Lower-cased extension of a path or file name, dot included. */
function extensionOf(filePath: string): string {
  const base = filePath.split(PATH_SEPARATOR).pop() || filePath;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * True when this area can draw the file as a PICTURE.
 *
 * That is any raster image, plus SVG: the main process serves SVG bytes
 * through axle:readImageFile (see IMAGE_VIEW_EXTRA_EXTENSIONS in main.ts), so
 * the image viewer can render it even though its source is XML.
 */
export function isImageFilePath(filePath: string): boolean {
  const ext = extensionOf(filePath);
  return RASTER_IMAGE_EXTENSIONS.has(ext) || PICTURE_ONLY_IMAGE_EXTENSIONS.has(ext);
}

/**
 * True when this area can show the file as TEXT.
 *
 * SVG is included on purpose: its source is an XML document, so the text
 * editor can open and edit it. A file may therefore be BOTH text and image
 * (SVG is the one case today); which one it becomes is the caller's choice.
 */
export function isTextFilePath(filePath: string): boolean {
  const ext = extensionOf(filePath);
  return (
    CODE_EXTENSIONS.has(ext) ||
    STRUCTURED_TEXT_EXTENSIONS.has(ext) ||
    PURE_TEXT_EXTENSIONS.has(ext)
  );
}

/**
 * The PREFERRED viewer for a file: 'image', 'text', or an empty verdict when
 * this area cannot show it at all.
 *
 * When a file qualifies for both (SVG), 'image' wins so this verdict agrees
 * with the main process in main.ts, which labels an SVG as an image - the
 * picture is what the user expects from a bare View request. Callers that want
 * a specific viewer should ask {@link isImageFilePath} / {@link isTextFilePath}
 * instead of comparing this single label.
 *
 * A file with an UNKNOWN extension yields the empty verdict: the main-process
 * classifier in common.ts sniffs those bytes, but this renderer module cannot,
 * so it defers to the verdict the caller already obtained instead of guessing.
 */
export function classifyViewFile(filePath: string): ViewFileKind | '' {
  if (isImageFilePath(filePath)) return 'image';
  if (isTextFilePath(filePath)) return 'text';
  return '';
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * Share of the main split (#main) the area takes on its FIRST reveal.
 *
 * The three-way contract is 30% chat / 45% view space / 25% dock. Only this
 * area and the dock are given an explicit width; the left column is the flex
 * filler (flex:3 in src/styles.css) that absorbs whatever is left, so asking
 * for 45% here while the dock keeps its 25% is what makes the chat land on
 * 30% with no width ever being written to the column.
 *
 * It is a FRACTION rather than a pixel size so the reveal is proportional on
 * any window size, matching how src/rightWorkspace.ts tracks the dock. The
 * stylesheet repeats the same 45% as the pre-JS default (see .view-space in
 * src/workingDir.css).
 */
const DEFAULT_WIDTH_FRACTION = 0.45;
/** Never narrower than this, or a tab strip becomes unusable. */
const MIN_WIDTH = 320;
/**
 * Always leave this much room for the chat and the right dock together. The
 * clamp is applied against the split width, so it also keeps the left column
 * from being squeezed to nothing on a narrow window.
 */
const MIN_REMAINING = 420;

/** One open file: its tab button, its panel and the live viewer inside it. */
interface ViewTab {
  /** Identity: kind + mode + path, so View and Edit of one file differ. */
  key: string;
  filePath: string;
  fileName: string;
  kind: ViewFileKind;
  readOnly: boolean;
  /** Retained so the header action can re-open this file in a modal dialog. */
  entry: ViewSpaceEntry;
  tabEl: HTMLButtonElement;
  panelEl: HTMLDivElement;
  /**
   * Live viewer handle; null until the viewer has been mounted.
   *
   * A TEXT tab holds a Monaco editor, whose `getContent` reports the buffer as
   * it is RIGHT NOW (see FileEditorHandle in src/fileEditor.ts); that is what
   * the header's dialog action hands to the floating editor, so a toggled file
   * carries its unsaved edits with it. `getSavedContent` is its counterpart -
   * the text that buffer was last PERSISTED as - and is handed over as well, so
   * the dialog knows the edits are still unsaved and keeps its Save button
   * enabled instead of mistaking the incoming buffer for a saved state.
   *
   * The flow is a ROUND TRIP, because a save can happen on either side: the
   * dialog reports its successful saves through FileEditorOptions.onSaved and
   * this tab adopts them with `markSaved`, so the unsaved marker and the
   * discard prompt disappear from a tab whose text is already on disk. Without
   * it the tab would keep comparing its buffer against the pre-toggle baseline
   * and claim changes that were saved in the dialog.
   *
   * An IMAGE tab holds a viewer with no text to read (and no baseline to
   * compare), so every member below except close is OPTIONAL and only the text
   * branch ever calls them.
   */
  handle: {
    close: () => void;
    getContent?: () => string;
    getSavedContent?: () => string;
    markSaved?: (content: string) => void;
  } | null;
}

let rootEl: HTMLElement | null = null;
let tabsEl: HTMLElement | null = null;
let panelsEl: HTMLElement | null = null;
let modalBtn: HTMLButtonElement | null = null;
let closeBtn: HTMLButtonElement | null = null;
let resizerEl: HTMLElement | null = null;

const tabs: ViewTab[] = [];
let activeKey: string | null = null;
let wired = false;

/** Current pixel width of the area (0 = never sized, use the stylesheet). */
let widthPx = 0;

// ---------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Floating-window glyph for the header's ONE-SHOT 'open in a dialog' action.
 * The docked/pressed counterpart is gone: the action never latches, so a single
 * icon describes it in every state.
 */
const ICON_FLOATING = ['M2.5 4.5h7v5h-7z', 'M11 7.5h2.5v6h-8v-2.5'];

/** Tooltip and accessible name of that action (mirrored in src/index.html). */
const MODAL_BUTTON_LABEL = 'Open the active file in a modal dialog';

/** Build a small stroke icon from path data, matching the viewer headers. */
const buildIcon = (paths: string[]): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', 'currentColor');
    pathEl.setAttribute('stroke-width', '1.5');
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pathEl);
  }
  return svg;
};

/**
 * Resolve the markup from src/index.html and install the one-time listeners.
 *
 * Returns false when the area is absent (an older index.html), in which case
 * every public entry point degrades to not handled and the caller keeps its
 * modal behaviour.
 */
function ensureDom(): boolean {
  if (wired) return true;
  const root = document.getElementById('view-space');
  const tabStrip = document.getElementById('view-space-tabs');
  const panelHost = document.getElementById('view-space-panels');
  if (!root || !tabStrip || !panelHost) return false;

  rootEl = root;
  tabsEl = tabStrip;
  panelsEl = panelHost;
  modalBtn = document.getElementById('view-space-modal') as HTMLButtonElement | null;
  closeBtn = document.getElementById('view-space-close') as HTMLButtonElement | null;
  resizerEl = root.querySelector('.view-space-resizer');

  if (closeBtn) closeBtn.addEventListener('click', () => closeViewSpace());
  if (modalBtn) {
    // ONE-SHOT action, never a toggle: it opens the active file in a floating
    // dialog and changes nothing about this area or about the button itself.
    // aria-pressed is stripped (an older index.html may still carry it) so no
    // pressed styling can apply, however many times the button is clicked.
    modalBtn.appendChild(buildIcon(ICON_FLOATING));
    modalBtn.title = MODAL_BUTTON_LABEL;
    modalBtn.setAttribute('aria-label', MODAL_BUTTON_LABEL);
    modalBtn.removeAttribute('aria-pressed');
    modalBtn.addEventListener('click', () => openActiveInModal());
  }
  if (resizerEl) resizerEl.addEventListener('mousedown', onResizerMouseDown);

  updatePathBox();

  wired = true;
  return true;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Width of the main split (#main), the box the three columns share.
 *
 * The area is a direct child of #main, so its parent IS the split. Falls back
 * to the window width when the parent is missing or not laid out yet (a hidden
 * ancestor reports clientWidth 0), so the reveal always produces a usable size
 * instead of a zero-width panel.
 */
function getSplitWidth(): number {
  const splitEl = rootEl ? rootEl.parentElement : null;
  return splitEl && splitEl.clientWidth > 0 ? splitEl.clientWidth : window.innerWidth;
}

/**
 * Reveal the area, sizing it on the very first show.
 *
 * FIRST reveal: the area takes DEFAULT_WIDTH_FRACTION of the split (45%). The
 * dock keeps its own 25% and the left column is the flex filler, so the chat
 * lands on the remaining 30% - the 30/45/25 layout - without this module ever
 * writing a width to the left column.
 *
 * LATER reveals: the width the user dragged to is restored, so closing and
 * reopening the area does not undo their layout. widthPx stays 0 until either
 * path has sized the area.
 */
function show(): void {
  if (!rootEl) return;
  const firstReveal = widthPx <= 0;
  rootEl.classList.remove('hidden');
  applyWidth(
    firstReveal ? Math.round(getSplitWidth() * DEFAULT_WIDTH_FRACTION) : widthPx
  );
}

/** Hide the area again once the last tab is gone. */
function hideIfEmpty(): void {
  if (!rootEl) return;
  if (tabs.length === 0) {
    rootEl.classList.add('hidden');
    activeKey = null;
    // Nothing is open any more, so the box must not keep describing a file
    // that is gone: leave search mode and fall back to its empty label.
    if (pathBox) pathBox.exitSearch();
    updatePathBox();
  }
}

/**
 * Clamp a candidate width to the area minimum and the space still available.
 *
 * The ceiling is measured against the SPLIT, not the window, because the split
 * is the box the three columns actually share: with the dock holding a fixed
 * share of it, a rail derived from the window would let the area push the chat
 * column (and the dock) out of the visible split. src/rightWorkspace.ts clamps
 * the dock against the same measurement, so both grips agree on the budget.
 *
 * Used by the 45% reveal and by every drag step, so the rail applies in both.
 */
function clampWidth(candidate: number): number {
  const maxAvailable = Math.max(MIN_WIDTH, getSplitWidth() - MIN_REMAINING);
  return Math.round(Math.min(Math.max(candidate, MIN_WIDTH), maxAvailable));
}

/** Apply a width in pixels, remembering the clamped value. */
function applyWidth(candidate: number): void {
  if (!rootEl) return;
  const width = clampWidth(candidate);
  widthPx = width;
  rootEl.style.width = width + 'px';
  // Pin the flex basis so the neighbours cannot squeeze the area back.
  rootEl.style.flex = '0 0 auto';
}

// ---------------------------------------------------------------------------
// Horizontal resize (left edge, mirrors #right-workspace)
// ---------------------------------------------------------------------------

let dragStartX = 0;
let dragStartWidth = 0;

function onResizerMouseDown(e: MouseEvent): void {
  if (!rootEl || e.button !== 0) return;
  dragStartX = e.clientX;
  dragStartWidth = rootEl.getBoundingClientRect().width;
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', onResizerMouseMove);
  window.addEventListener('mouseup', onResizerMouseUp);
  e.preventDefault();
}

function onResizerMouseMove(e: MouseEvent): void {
  // The grip sits on the LEFT edge, so dragging left GROWS the area.
  applyWidth(dragStartWidth + (dragStartX - e.clientX));
}

function onResizerMouseUp(): void {
  document.body.style.userSelect = '';
  window.removeEventListener('mousemove', onResizerMouseMove);
  window.removeEventListener('mouseup', onResizerMouseUp);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Build the tab button and the empty panel that will hold the viewer. */
function createTabShell(entry: ViewSpaceEntry, readOnly: boolean): ViewTab {
  const key = entry.kind + '|' + (readOnly ? 'v' : 'e') + '|' + entry.filePath;

  const tabEl = document.createElement('button');
  tabEl.type = 'button';
  tabEl.className = 'view-space-tab';
  tabEl.title = entry.filePath;

  const labelEl = document.createElement('span');
  labelEl.className = 'view-space-tab-label';
  labelEl.textContent = entry.fileName;

  const tabClose = document.createElement('span');
  tabClose.className = 'view-space-tab-close';
  tabClose.textContent = '×';
  tabClose.title = 'Close this file';
  tabClose.setAttribute('role', 'button');
  tabClose.setAttribute('aria-label', 'Close ' + entry.fileName);

  tabEl.appendChild(labelEl);
  tabEl.appendChild(tabClose);

  const panelEl = document.createElement('div');
  panelEl.className = 'view-space-panel';
  panelEl.style.display = 'none';

  const tab: ViewTab = {
    key,
    filePath: entry.filePath,
    fileName: entry.fileName,
    kind: entry.kind,
    readOnly,
    entry,
    tabEl,
    panelEl,
    handle: null
  };

  tabEl.addEventListener('click', (ev) => {
    if (ev.target === tabClose) return;
    activate(key);
  });
  // A tab's X goes through the viewer so a dirty editable buffer still asks
  // before its edits are dropped.
  tabClose.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeTab(tab);
  });

  return tab;
}

/**
 * Paint the unsaved-changes marker on a tab.
 *
 * An embedded editor renders no title bar, so the dot that normally marks a
 * dirty buffer has nowhere to live; src/fileEditor.ts reports the state
 * through its onDirtyChange callback and it lands on the tab instead. The
 * caller passes `false` when a tab is closed, but the class would vanish with
 * the element anyway, so this stays cheap and idempotent.
 */
function setTabDirty(tab: ViewTab, dirty: boolean): void {
  tab.tabEl.classList.toggle('dirty', dirty);
  tab.tabEl.title = dirty
    ? tab.filePath + ' \u2014 unsaved changes'
    : tab.filePath;
}

/** Make one tab the visible one. */
function activate(key: string): void {
  activeKey = key;
  for (const tab of tabs) {
    const isActive = tab.key === key;
    tab.panelEl.style.display = isActive ? 'block' : 'none';
    tab.tabEl.classList.toggle('active', isActive);
  }
  // Both viewers track their box themselves (Monaco through automaticLayout,
  // the image viewer through a ResizeObserver on its surface), so revealing a
  // panel is enough: no manual relayout call is needed here.

  // The path box always describes the ACTIVE file, so it follows the switch.
  updatePathBox();
}

/**
 * Mount the right viewer into a tab's panel.
 *
 * onClose is wired to handleViewerClosed rather than to closeTab, so a viewer
 * that closes ITSELF (its own header button) removes the tab without recursing
 * back into handle.close().
 */
function mountViewer(tab: ViewTab): void {
  const entry = tab.entry;
  if (tab.kind === 'text') {
    tab.handle = openFileEditor({
      fileName: entry.fileName,
      filePath: entry.filePath,
      content: entry.content ?? '',
      readOnly: tab.readOnly,
      save: tab.readOnly ? undefined : entry.save,
      embedded: true,
      parent: tab.panelEl,
      onClose: () => handleViewerClosed(tab),
      // The embedded editor renders no title bar, so the unsaved-changes dot
      // is painted on this tab instead of inside the editor.
      onDirtyChange: (dirty) => setTabDirty(tab, dirty)
    });
    return;
  }
  tab.handle = openImageViewer({
    fileName: entry.fileName,
    filePath: entry.filePath,
    mimeType: entry.mimeType ?? 'image/png',
    base64: entry.base64 ?? '',
    embedded: true,
    parent: tab.panelEl,
    onClose: () => handleViewerClosed(tab)
  });
}

/** A viewer disposed itself: drop its tab. */
function handleViewerClosed(tab: ViewTab): void {
  tab.handle = null;
  removeTab(tab);
}

/** Ask a tab's viewer to close; disposal then triggers handleViewerClosed. */
function closeTab(tab: ViewTab): void {
  const handle = tab.handle;
  if (handle) {
    // Null it first: a viewer that closes itself calls onClose, and clearing the
    // reference here keeps that from re-entering this function.
    tab.handle = null;
    handle.close();
    return;
  }
  removeTab(tab);
}

/** Remove a tab from the strip and the panels, disposing its viewer. */
function removeTab(tab: ViewTab): void {
  const index = tabs.indexOf(tab);
  if (index === -1) return;
  tabs.splice(index, 1);

  // A viewer that closed itself has already been disposed and cleared its
  // handle; one that did not is disposed here. Either way, only one close runs.
  const handle = tab.handle;
  tab.handle = null;
  if (handle) handle.close();

  tab.tabEl.remove();
  tab.panelEl.remove();

  if (activeKey === tab.key) {
    const next = tabs[tabs.length - 1];
    if (next) activate(next.key);
    else activeKey = null;
  }
  hideIfEmpty();
}

/**
 * Model that currently OWNS this view space (null until the first switch).
 *
 * The area is model based, exactly like the right-dock 'Files' tab (see
 * setFilesModelName in src/filesTab.ts): every model keeps its own view space,
 * and switching models never reveals the files of the model left behind.
 */
let currentModelName: string | null = null;

/**
 * Destroy everything this area holds for the model being left behind.
 *
 * Every viewer is closed (so no Monaco model, listener or object URL leaks),
 * the tab and panel elements are removed, the active tab and the remembered
 * width are cleared and the area is collapsed again. The width is cleared on
 * purpose: the incoming model starts from the default share the next time it
 * reveals the area, instead of inheriting the layout of another model.
 */
function destroyViewSpace(): void {
  for (const tab of tabs.slice()) {
    const handle = tab.handle;
    tab.handle = null;
    if (handle) handle.close();
    tab.tabEl.remove();
    tab.panelEl.remove();
  }
  tabs.length = 0;
  activeKey = null;
  widthPx = 0;

  if (rootEl) {
    rootEl.classList.add('hidden');
    rootEl.style.width = '';
    rootEl.style.flex = '';
  }

  // Nothing is open any more, so the path box must stop describing a file that
  // is gone: leave search mode and fall back to its empty label.
  if (pathBox) pathBox.exitSearch();
  updatePathBox();
}

/**
 * Point this view space at the model in focus (called by renderer.ts on every
 * model switch, right next to setFilesModelName).
 *
 * Switching models DESTROYS the view space of the model being left behind and
 * leaves the incoming model COLLAPSED: its files are not carried over and
 * nothing of the previous model survives. A repeated call for the same model is
 * a no-op, so re-selecting the current tab never throws the open files away.
 */
export function setViewSpaceModelName(modelName: string | null): void {
  if (modelName === currentModelName) return;
  currentModelName = modelName;
  // Nothing has been mounted yet: there is no earlier view space to destroy.
  if (!wired) return;
  destroyViewSpace();
}

/** Dispose every tab and hide the area. */
function closeViewSpace(): void {
  // Closing the whole area is ONE deliberate act, so the tabs are disposed
  // directly instead of walking requestClose and its discard prompt once per
  // dirty buffer. Every viewer is closed, so no Monaco model or listener leaks.
  for (const tab of tabs.slice()) {
    const handle = tab.handle;
    tab.handle = null;
    if (handle) handle.close();
    tab.tabEl.remove();
    tab.panelEl.remove();
  }
  tabs.length = 0;
  activeKey = null;
  hideIfEmpty();
}

// ---------------------------------------------------------------------------
// One-shot modal action
// ---------------------------------------------------------------------------

/**
 * Open one tab's file in the modal dialog it would have used before this module.
 *
 * A TEXT tab is handed the LIVE editor buffer (tab.handle.getContent()), never
 * the `content` snapshot the entry was mounted with: the file may have been
 * edited since it was opened, and a dialog launched from this header must show
 * what the user is looking at right now, unsaved edits included. Reading the
 * buffer instead of the snapshot is what keeps the toggle from silently rolling
 * the file back to its state at open time.
 *
 * `entry.content` survives only as the fallback for a text tab whose editor is
 * not mounted yet (no handle, e.g. a tab still being built).
 *
 * The dirty state is carried over too, and that is the subtle half: the dialog
 * is seeded with the LIVE buffer, so if it also treated that text as its saved
 * baseline it would consider itself up to date, disable Save and leave the
 * user's unsaved edits with no way to persist them. The editor's own baseline
 * (getSavedContent) is therefore forwarded as `savedContent` whenever the two
 * differ, which is exactly what keeps the dialog dirty - and its Save button
 * clickable - for a tab whose edits are not on disk yet. When the buffer is
 * clean the baseline is identical and nothing is forwarded, so a clean file
 * still opens with Save disabled. A view-only tab renders no Save button at
 * all, so it forwards no baseline either.
 *
 * An IMAGE tab has no text to re-read and its base64 payload never changes, so
 * the viewer is opened from the entry unchanged.
 */
function openModal(tab: ViewTab): void {
  const entry = tab.entry;
  if (entry.kind === 'text') {
    const live = tab.handle?.getContent?.();
    const liveText = typeof live === 'string' ? live : null;
    // Only the LIVE buffer can be dirty: the entry's snapshot is a plain string
    // with no baseline to compare against, so the fallback path leaves the
    // dialog on its default (clean) baseline.
    const baseline = liveText !== null && !tab.readOnly
      ? tab.handle?.getSavedContent?.()
      : undefined;
    openFileEditor({
      fileName: entry.fileName,
      filePath: entry.filePath,
      content: liveText !== null ? liveText : entry.content ?? '',
      // Forward the baseline ONLY when it is older than the buffer: an equal
      // value would just restate `content`, and an undefined getter (an editor
      // that has none) falls back to the clean default.
      savedContent:
        typeof baseline === 'string' && baseline !== liveText ? baseline : undefined,
      readOnly: tab.readOnly,
      save: tab.readOnly ? undefined : entry.save,
      // The round trip: this tab and the dialog hold INDEPENDENT Monaco buffers
      // over one file, so a save in the dialog would otherwise leave the tab
      // marked dirty (and asking to discard edits that are already on disk).
      // The dialog reports its successful saves here and the tab's editor
      // adopts them. Optional accessors guard the case where the tab was
      // closed while the dialog stayed open.
      onSaved: (saved) => {
        tab.handle?.markSaved?.(saved);
      }
    });
    return;
  }
  openImageViewer({
    fileName: entry.fileName,
    filePath: entry.filePath,
    mimeType: entry.mimeType ?? 'image/png',
    base64: entry.base64 ?? ''
  });
}

/**
 * Header action: re-open the ACTIVE file in a floating modal dialog.
 *
 * ONE-SHOT, not a mode. The tab stays in place, this area keeps hosting every
 * later View/Edit request, and no state is recorded - so the button looks the
 * same after a click as before it, and clicking it again simply opens another
 * dialog. There is nothing to switch back from, because nothing was switched.
 *
 * The dialog it opens is seeded from the tab's live buffer (see openModal), so
 * the toggle follows the file the user has been editing rather than the copy
 * that existed when the tab was opened.
 */
function openActiveInModal(): void {
  const active = tabs.find((t) => t.key === activeKey);
  if (active) openModal(active);
}

// ---------------------------------------------------------------------------
// File path box
// ---------------------------------------------------------------------------

/** The tab currently shown, or undefined when the area is empty. */
function activeTab(): ViewTab | undefined {
  return tabs.find((t) => t.key === activeKey);
}

/** Full path of the active file, or '' when no tab is open. */
function activeFilePath(): string {
  const tab = activeTab();
  return tab ? tab.filePath : '';
}

/**
 * Write the active file's path into the box.
 *
 * READ-ONLY state: this is the plain text of the current file. While the box is
 * a SEARCH FIELD the text stays out of sight (the input covers it), but it is
 * still updated so leaving search mode shows the right path immediately.
 */
function updatePathBox(): void {
  if (!pathBox) return;
  // The box decides how the path is drawn (read-only line, ellipsised) and
  // leaves search mode by itself when the path actually changes, because a
  // different file means a different neighbourhood to query.
  pathBox.setPath(activeFilePath());
}

/**
 * Open a match picked in a path box, in the view space.
 *
 * The file is read through the channels that already guard reads (readFileRaw
 * for text, readImageFile for images) and then mounted exactly the way the
 * 'Files' tab mounts a file, so a match behaves like any other View request: a
 * text file opens in a VIEW-ONLY tab, an image in an image tab, and the modal
 * dialogs remain the fallback if this area declines the request.
 *
 * This is the ONE opener for every path box in the application: it is handed to
 * setPathBoxOpenHandler at module scope, so a match picked in the code editor's
 * or the image preview's path line lands here too. Keeping it in this module is
 * what lets a match open the way this area opens files, without src/pathBox.ts
 * ever importing a host that imports it back.
 */
async function openSearchResult(filePath: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;

  // Already open: just bring that tab to the front.
  const existing = tabs.find((t) => t.filePath === filePath);
  if (existing) {
    show();
    activate(existing.key);
    return;
  }

  const fileName = baseNameOf(filePath);

  // TEXT first: a file that is both (an SVG) opens as XML text, matching the
  // text route the 'Files' tab takes for an Edit request.
  if (isTextFilePath(filePath) && typeof bridge.readFileRaw === 'function') {
    try {
      const read = await bridge.readFileRaw(filePath);
      if (!read || !read.ok || typeof read.content !== 'string') {
        window.alert((read && read.error) || 'Unable to read this file.');
        return;
      }
      if (
        openInViewSpace({
          filePath,
          fileName,
          kind: 'text',
          content: read.content,
          readOnly: true
        })
      ) {
        return;
      }
      openFileEditor({
        fileName,
        filePath,
        content: read.content,
        readOnly: true
      });
    } catch (e) {
      console.error('[viewSpace] Failed to open the search result', filePath, e);
      window.alert(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  if (isImageFilePath(filePath) && typeof bridge.readImageFile === 'function') {
    try {
      const result = await bridge.readImageFile(filePath);
      if (
        !result ||
        !result.ok ||
        typeof result.base64 !== 'string' ||
        typeof result.mimeType !== 'string'
      ) {
        window.alert((result && result.error) || 'Unable to read this image.');
        return;
      }
      if (
        openInViewSpace({
          filePath,
          fileName,
          kind: 'image',
          mimeType: result.mimeType,
          base64: result.base64
        })
      ) {
        return;
      }
      openImageViewer({
        fileName,
        filePath,
        mimeType: result.mimeType,
        base64: result.base64
      });
    } catch (e) {
      console.error('[viewSpace] Failed to open the search result', filePath, e);
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Show a file in the view space, revealing the area if it is still hidden.
 *
 * Returns TRUE when the request was handled here and FALSE when it was not, so
 * the caller can fall back to its previous behaviour. A request is refused when
 * the area is not present in the document (an older index.html), or when this
 * area cannot render the REQUESTED kind for that path - the test is per kind, so
 * a file that is both (an SVG: XML source and picture bytes) is accepted for
 * whichever kind the caller asked for.
 *
 * A file already open in the same mode is brought to the front instead of
 * mounting a second editor on the same buffer.
 */
export function openInViewSpace(entry: ViewSpaceEntry): boolean {
  if (!ensureDom()) return false;
  if (!entry || !entry.filePath) return false;

  // Hold this module to its promise: text and images only. The check is per
  // REQUESTED kind, not on the single preferred label, because one file can be
  // both: an SVG previews as a picture and edits as XML text. Comparing the
  // preferred label instead would refuse the preview the main process just
  // served, which is how SVG files used to fall back to the modal dialog.
  if (entry.kind === 'image') {
    if (!isImageFilePath(entry.filePath)) return false;
  } else if (entry.kind === 'text') {
    if (!isTextFilePath(entry.filePath)) return false;
  } else {
    return false;
  }

  const readOnly = entry.kind === 'text' ? entry.readOnly === true : false;
  const key = entry.kind + '|' + (readOnly ? 'v' : 'e') + '|' + entry.filePath;

  const existing = tabs.find((t) => t.key === key);
  if (existing) {
    show();
    activate(existing.key);
    return true;
  }

  const tab = createTabShell(entry, readOnly);
  tabs.push(tab);
  if (tabsEl) tabsEl.appendChild(tab.tabEl);
  if (panelsEl) panelsEl.appendChild(tab.panelEl);

  // Reveal the area and the panel BEFORE mounting: both embedded viewers
  // measure their host on construction, and a display:none panel would hand
  // them a zero-sized box.
  show();
  activate(tab.key);
  mountViewer(tab);

  return true;
}

/** True when at least one file is currently shown in the area. */
export function isViewSpaceOpen(): boolean {
  return tabs.length > 0;
}


// ---------------------------------------------------------------------------
// App-wide "open this match" action for the shared path box
// ---------------------------------------------------------------------------
// The SAME searchable box (src/pathBox.ts) is mounted by this area, by the code
// editor's path line and by the image preview's path line, so a match can be
// picked from any of the three. Exactly one opener serves all of them, and it is
// the one that already knows how this application shows a file:
// openSearchResult reads the bytes through the guarded channels and mounts them
// here, falling back to the modal dialogs when this area declines.
//
// Registered at module scope because it is a single application-wide hook, not
// per-instance state; openSearchResult is a hoisted function declaration, so the
// call can sit above its definition. Injecting it (rather than importing this
// module from pathBox.ts) keeps the dependency graph acyclic:
//
//     viewSpace -> fileEditor  -> pathBox
//     viewSpace -> imageViewer -> pathBox
//
// so pathBox never imports a host that imports it back.
setPathBoxOpenHandler(openSearchResult);

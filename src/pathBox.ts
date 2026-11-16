/**
 * pathBox.ts - the ONE searchable file-path box, shared by every surface that
 * shows which file is open.
 *
 * Three places in the application need to say "this is the file you are looking
 * at", and they are the SAME control:
 *
 *     view space header        src/viewSpace.ts   (the ACTIVE tab's file)
 *     code editor path line    src/fileEditor.ts  (floating and embedded)
 *     image path line          src/imageViewer.ts (floating and embedded)
 *
 * All three mount this module, so ONE style class family (.path-box*) draws
 * every instance and one piece of code owns the behaviour.
 *
 * The box is a READ-ONLY path line by default. The magnifier button sits INSIDE
 * the box, pinned to its RIGHT edge: pressing it turns the same box into an
 * editable search field (typing queries the file tree and the matches drop down
 * under the box) and pressing it again - or Escape, or a click outside - drops
 * the query and shows the plain, non-editable path again.
 *
 * NOTE: this is RENDERER code, so it must not import src/common/common.ts: that
 * module pulls in fs and ssh2. The bridge interface below declares only what
 * the box itself calls, exactly like FilesBridge in src/filesTab.ts.
 */

/** The subset of window.axle the path box needs. */
interface PathBoxBridge {
  /**
   * Search `basePath` for files whose NAME matches `query`. A bare word is a
   * substring match; a query containing regular-expression metacharacters is
   * used exactly as typed. Remote (ssh://) bases run the remote bash find.
   */
  findFiles(
    basePath: string,
    query: string,
    modelName?: string
  ): Promise<{ ok: boolean; paths?: string[]; error?: string }>;
  /**
   * Working directory of the active model, used when the box has no file of
   * its own to search next to. A remote answer is an ssh:// path, which is
   * what main.ts needs to switch to the remote find.
   */
  getWorkingDirInfo?(modelName?: string): Promise<
    | { kind: 'local'; path: string }
    | { kind: 'remote'; serverName: string; path: string }
  >;
}

/** Read the bridge (it may be undefined during early startup). */
function getBridge(): Partial<PathBoxBridge> | undefined {
  return (window as unknown as { axle?: Partial<PathBoxBridge> }).axle;
}

/** What happens when a match is chosen and the host supplied no callback. */
type OpenHandler = (filePath: string) => void | Promise<void>;

let sharedOpenHandler: OpenHandler | null = null;

/**
 * Install the application-wide "open this file" action.
 *
 * src/viewSpace.ts calls this once, so a match picked in an editor's or a
 * preview's path line opens exactly the way the view space's own search does.
 * Injecting it keeps the module graph acyclic: viewSpace -> fileEditor ->
 * pathBox, and fileEditor never has to import viewSpace.
 */
export function setPathBoxOpenHandler(handler: OpenHandler | null): void {
  sharedOpenHandler = handler;
}

/** Options accepted by buildPathBox. */
export interface PathBoxOptions {
  /** Initial path shown in the read-only line. */
  path?: string;
  /** Text shown when no path is known (default 'No file open'). */
  emptyLabel?: string;
  /** Extra class on the root, for the host's own spacing/geometry. */
  className?: string;
  /**
   * Filter for matches. The view space passes its text/image classifier so the
   * dropdown never offers a file it cannot draw; hosts that can open anything
   * simply omit it.
   */
  accept?: (filePath: string) => boolean;
  /**
   * Directory the query runs against, asked per search so a host can answer
   * with the file it currently shows. Returning '' aborts the search.
   * Defaults to the parent directory of the current path, then to the active
   * model's working directory.
   */
  searchBaseDir?: () => string | Promise<string>;
  /** A match was chosen. Defaults to the app-wide handler. */
  onPick?: (filePath: string) => void | Promise<void>;
  /** Search mode was turned on (true) or off (false). */
  onSearchModeChange?: (searching: boolean) => void;
  /** Mount point; the root is appended here when given. */
  parent?: HTMLElement;
}

/** Live handle returned by buildPathBox. */
export interface PathBoxHandle {
  /** The root element, already carrying the .path-box markup. */
  el: HTMLElement;
  /** Show a new path; leaves search mode when the path actually changes. */
  setPath(path: string): void;
  /** Drop the query and go back to the plain path line. */
  exitSearch(): void;
  /** True while the box is an editable search field. */
  isSearching(): boolean;
  /** Remove listeners and timers (idempotent). */
  dispose(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Typing must pause this long before a query runs (it coalesces a burst). */
const SEARCH_DEBOUNCE_MS = 200;

/** Matches actually rendered in the dropdown (a query may return more). */
const MAX_VISIBLE_MATCHES = 50;

/** Toggle glyph: a magnifier drawn with the viewers' own stroke style. */
const ICON_SEARCH = [
  'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  'M10.6 10.6 14 14'
];

const TOGGLE_LABEL = 'Search for a file';
const TOGGLE_LABEL_ACTIVE = 'Show the file path';
const SEARCH_PLACEHOLDER = 'Search files by name or regular expression';
const DEFAULT_EMPTY_LABEL = 'No file open';

/** Directory part of a path; both separators are understood. */
function parentDirOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}

/** Last path segment, used as the display name of a match. */
function baseNameOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut >= 0 ? filePath.slice(cut + 1) : filePath;
}

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
 * Build the shared path box and return a handle to it.
 *
 * The root is NOT attached to the document here (unless `parent` is given), so
 * the caller can put it exactly where its own layout wants it and measure it
 * afterwards, which is what src/imageViewer.ts does with its chrome maths.
 */
export function buildPathBox(options: PathBoxOptions = {}): PathBoxHandle {
  const emptyLabel = options.emptyLabel ?? DEFAULT_EMPTY_LABEL;

  // ---- DOM ----
  const rootEl = document.createElement('div');
  rootEl.className = options.className ? 'path-box ' + options.className : 'path-box';

  const textEl = document.createElement('span');
  textEl.className = 'path-box-text';

  const inputEl = document.createElement('input');
  inputEl.className = 'path-box-input hidden';
  inputEl.type = 'text';
  inputEl.spellcheck = false;
  inputEl.autocomplete = 'off';
  inputEl.placeholder = SEARCH_PLACEHOLDER;
  inputEl.setAttribute('aria-label', SEARCH_PLACEHOLDER);

  const toggleEl = document.createElement('button');
  toggleEl.className = 'path-box-toggle';
  toggleEl.type = 'button';
  toggleEl.appendChild(buildIcon(ICON_SEARCH));
  toggleEl.title = TOGGLE_LABEL;
  toggleEl.setAttribute('aria-label', TOGGLE_LABEL);
  toggleEl.setAttribute('aria-pressed', 'false');

  const resultsEl = document.createElement('div');
  resultsEl.className = 'path-box-results hidden';
  resultsEl.setAttribute('role', 'listbox');
  resultsEl.setAttribute('aria-label', 'Matching files');

  rootEl.appendChild(textEl);
  rootEl.appendChild(inputEl);
  rootEl.appendChild(toggleEl);
  rootEl.appendChild(resultsEl);

  // ---- State ----
  let currentPath = options.path ?? '';
  let searchMode = false;
  let disposed = false;
  let timer: number | null = null;
  /** Bumped per search so a slow answer cannot overwrite a newer one. */
  let token = 0;
  /** Paths of the current match list, in display order. */
  let matches: string[] = [];
  /** Keyboard-selected row, -1 when nothing is selectable. */
  let selected = -1;

  /** Paint the read-only line (and its tooltip). */
  const renderPath = (): void => {
    textEl.textContent = currentPath || emptyLabel;
    textEl.title = currentPath;
  };
  renderPath();

  // ---- Dropdown ----
  const showResults = (): void => {
    resultsEl.classList.remove('hidden');
  };

  const hideResults = (): void => {
    resultsEl.classList.add('hidden');
    resultsEl.textContent = '';
    matches = [];
    selected = -1;
  };

  /** Draw one non-selectable line in the dropdown. */
  const renderHint = (text: string): void => {
    resultsEl.textContent = '';
    const hint = document.createElement('span');
    hint.className = 'path-box-hint';
    hint.textContent = text;
    resultsEl.appendChild(hint);
    matches = [];
    selected = -1;
    showResults();
  };

  /** Paint the keyboard selection on the rendered rows. */
  const updateSelection = (): void => {
    const rows = resultsEl.querySelectorAll('.path-box-result');
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('selected', i === selected);
    }
    const chosen = resultsEl.querySelector('.path-box-result.selected');
    if (chosen && typeof (chosen as HTMLElement).scrollIntoView === 'function') {
      (chosen as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  };

  /**
 * Render the match list: ONE line per file - the name first, then its dimmed
 * directory. The single-line layout is set by the .path-box-result flex row in
 * src/workingDir.css; this function only builds the two spans, in that order.
 */
  const renderMatches = (paths: string[]): void => {
    resultsEl.textContent = '';
    matches = paths.slice();
    selected = paths.length > 0 ? 0 : -1;

    for (let i = 0; i < paths.length; i++) {
      const filePath = paths[i];
      const row = document.createElement('div');
      row.className = 'path-box-result';
      row.setAttribute('role', 'option');
      row.title = filePath;

      const nameEl = document.createElement('span');
      nameEl.className = 'path-box-result-name';
      nameEl.textContent = baseNameOf(filePath);

      const dirEl = document.createElement('span');
      dirEl.className = 'path-box-result-dir';
      dirEl.textContent = parentDirOf(filePath);

      row.appendChild(nameEl);
      row.appendChild(dirEl);
      // mousedown (not click) so the row opens before the capture-phase outside
      // handler can leave search mode and tear the dropdown down.
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openMatch(filePath);
      });
      row.addEventListener('mouseenter', () => {
        selected = i;
        updateSelection();
      });
      resultsEl.appendChild(row);
    }
    updateSelection();
    showResults();
  };

  // ---- Search ----
  /**
   * Directory the query runs against: the host's answer when it supplied one,
   * else the current file's own directory, else the active model's working
   * directory (an ssh:// path for a remote working directory).
   */
  const resolveBaseDir = async (): Promise<string> => {
    if (options.searchBaseDir) {
      try {
        return await options.searchBaseDir();
      } catch (err) {
        console.error('[pathBox] searchBaseDir handler failed', err);
        return '';
      }
    }
    if (currentPath) return parentDirOf(currentPath);

    const bridge = getBridge();
    if (!bridge || typeof bridge.getWorkingDirInfo !== 'function') return '';
    try {
      const info = await bridge.getWorkingDirInfo();
      if (!info) return '';
      if (info.kind === 'remote') return 'ssh://' + info.serverName + info.path;
      return info.path;
    } catch (err) {
      return '';
    }
  };

  /** Run the query currently in the field and paint the matches. */
  const runSearch = async (): Promise<void> => {
    if (disposed) return;
    const query = inputEl.value.trim();
    const mine = ++token;

    // An emptied box is not a search: drop the list instead of walking the tree.
    if (!query) {
      hideResults();
      return;
    }

    const bridge = getBridge();
    if (!bridge || typeof bridge.findFiles !== 'function') {
      renderHint('File search is unavailable: the application bridge is not ready.');
      return;
    }

    const baseDir = await resolveBaseDir();
    if (disposed || mine !== token) return;
    if (!baseDir) {
      renderHint('Open a file first to search next to it.');
      return;
    }

    const result = await bridge.findFiles(baseDir, query);
    // A newer keystroke already started another search: this answer is stale.
    if (disposed || mine !== token) return;

    if (!result || !result.ok) {
      renderHint((result && result.error) || 'Search failed.');
      return;
    }

    const found: string[] = [];
    const listed = result.paths || [];
    for (let i = 0; i < listed.length && found.length < MAX_VISIBLE_MATCHES; i++) {
      const candidate = listed[i];
      if (options.accept && !options.accept(candidate)) continue;
      found.push(candidate);
    }

    if (found.length === 0) {
      renderHint('No matching file.');
      return;
    }
    renderMatches(found);
  };

  /**
   * Queue a search 200ms after the last keystroke.
   *
   * 'input' fires for every character TYPED or REMOVED (and for pastes and
   * cuts), so an edit never goes unnoticed; the delay only coalesces a burst
   * of keystrokes into one directory walk.
   */
  const scheduleSearch = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void runSearch();
    }, SEARCH_DEBOUNCE_MS);
  };

  /** Choose a match: leave search mode, then hand the path to the host. */
  const openMatch = (filePath: string): void => {
    setSearchMode(false);
    const handler = options.onPick ?? sharedOpenHandler;
    if (!handler) return;
    try {
      void handler(filePath);
    } catch (err) {
      console.error('[pathBox] onPick handler failed', err);
    }
  };

  // ---- Search mode ----
  /**
   * Turn the box into a search field (`on`) or back into plain path text.
   *
   * LEAVING search mode always clears the field and the dropdown, so the plain
   * path is what the user sees again and a half-typed query can never leak into
   * the next time the box is opened.
   */
  function setSearchMode(on: boolean): void {
    if (disposed || searchMode === on) return;
    searchMode = on;

    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    token++;

    toggleEl.classList.toggle('active', on);
    toggleEl.setAttribute('aria-pressed', on ? 'true' : 'false');
    toggleEl.title = on ? TOGGLE_LABEL_ACTIVE : TOGGLE_LABEL;
    toggleEl.setAttribute('aria-label', toggleEl.title);

    textEl.classList.toggle('hidden', on);
    inputEl.classList.toggle('hidden', !on);
    if (on) {
      inputEl.value = '';
      inputEl.focus();
      inputEl.select();
    } else {
      inputEl.value = '';
      inputEl.blur();
    }

    hideResults();
    renderPath();

    if (options.onSearchModeChange) {
      try {
        options.onSearchModeChange(on);
      } catch (err) {
        console.error('[pathBox] onSearchModeChange handler failed', err);
      }
    }
  }

  // ---- Events ----
  const onToggleClick = (): void => setSearchMode(!searchMode);

  const onInput = (): void => scheduleSearch();

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      setSearchMode(false);
      return;
    }
    if (ev.key === 'Enter') {
      if (matches.length === 0) return;
      ev.preventDefault();
      const index = selected >= 0 ? selected : 0;
      const chosen = matches[index];
      if (chosen) openMatch(chosen);
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (matches.length === 0) return;
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      const next = selected + step;
      if (next < 0) selected = matches.length - 1;
      else if (next >= matches.length) selected = 0;
      else selected = next;
      updateSelection();
    }
  };

  /** Leave search mode when the pointer goes down anywhere outside the box. */
  const onDocumentMouseDown = (ev: MouseEvent): void => {
    if (!searchMode) return;
    const target = ev.target as Node | null;
    if (!target) return;
    if (rootEl.contains(target)) return;
    setSearchMode(false);
  };

  toggleEl.addEventListener('click', onToggleClick);
  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKeyDown);
  // Capture phase, so a click on a match row still reaches the row first.
  document.addEventListener('mousedown', onDocumentMouseDown, true);

  if (options.parent) options.parent.appendChild(rootEl);

  // ---- Handle ----
  return {
    el: rootEl,
    setPath(path: string): void {
      if (disposed || path === currentPath) return;
      currentPath = path;
      renderPath();
      // A different file means a different neighbourhood: drop the query.
      if (searchMode) setSearchMode(false);
    },
    exitSearch(): void {
      setSearchMode(false);
    },
    isSearching(): boolean {
      return searchMode;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      token++;
      toggleEl.removeEventListener('click', onToggleClick);
      inputEl.removeEventListener('input', onInput);
      inputEl.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
      rootEl.remove();
    }
  };
}

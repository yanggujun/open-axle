/**
 * rightWorkspace.ts - the pluggable RIGHT-side workspace dock.
 *
 * The app's main area is split horizontally:
 *   - LEFT  (#workspaces): the per-model chat workspaces.
 *   - RIGHT (#right-workspace): this dock. It hosts a strip of tabs whose
 *     CONTENT TYPES ARE PLUGGABLE: any module can register a new tab type at
 *     runtime via registerRightTab() (or the global window.rightWorkspace API)
 *     and it will appear as a tab in the dock.
 *
 * Two tab types are built in and registered by renderer.ts:
 *   - 'logs'  -> the live application log (src/logView.ts)
 *   - 'files' -> the working directory's sub-folders and files (src/filesTab.ts)
 *
 * A tab type is described by a RightTabDefinition: an id, a title, an optional
 * icon and order, and a mount() function that builds the tab's DOM inside the
 * supplied container. mount() may return a RightTabInstance to supply lifecycle
 * hooks (onShow / onHide / refresh / dispose).
 *
 * The dock is designed so tabs are INDEPENDENT: each open tab owns its own
 * panel element and instance; opening/closing one never disturbs the others.
 * Only the active tab's panel is visible.
 */

/** Context handed to a tab's mount() function. */
export interface RightTabContext {
  /** Container element the tab must fill with its content. */
  container: HTMLElement;
  /** The dock API (so a tab can open/close/refresh other tabs). */
  api: RightWorkspaceApi;
  /** Bring THIS tab to the front. */
  activate(): void;
  /** Close THIS tab. */
  close(): void;
}

/** Optional lifecycle hooks returned by a tab's mount(). */
export interface RightTabInstance {
  /** Content element, if mount() did not append it to ctx.container itself. */
  el?: HTMLElement;
  /** Called when the tab becomes the active tab. */
  onShow?(): void;
  /** Called when the tab stops being the active tab. */
  onHide?(): void;
  /** Called by refreshRightTab() to reload the tab's content. */
  refresh?(): void;
  /** Called once when the tab is closed, to release resources. */
  dispose?(): void;
}

/** A pluggable tab TYPE. Multiple tab types may be registered. */
export interface RightTabDefinition {
  /** Stable unique id (used by openRightTab / closeRightTab). */
  id: string;
  /** Label shown in the tab strip. */
  title: string;
  /** Optional short icon/glyph shown before the title. */
  icon?: string;
  /** Optional sort order (lower = further left). Defaults to 100. */
  order?: number;
  /** Build the tab's content. Called once when the tab is first opened. */
  mount(ctx: RightTabContext): RightTabInstance | void;
}

/** An OPEN tab: a definition plus its instantiated DOM + hooks. */
interface OpenTab {
  def: RightTabDefinition;
  panel: HTMLElement;
  tabEl: HTMLElement;
  instance: RightTabInstance | null;
}

/** Public API surface (also exposed as window.rightWorkspace). */
export interface RightWorkspaceApi {
  /** Register (or replace) a tab TYPE. */
  registerTab(def: RightTabDefinition): void;
  /** Open a registered tab type (creating it on first open) and activate it. */
  openTab(id: string): void;
  /** Close an open tab, disposing its instance. */
  closeTab(id: string): void;
  /** Refresh one open tab (by id) or the active tab when omitted. */
  refreshTab(id?: string): void;
  /** Refresh the active tab. */
  refreshActiveTab(): void;
  /** Whether the dock currently has the given tab open. */
  isOpen(id: string): boolean;
  /** Show the dock. */
  show(): void;
  /** Hide the dock. */
  hide(): void;
  /** Minimize the dock to a thin far-right strip (extend button only). */
  collapse(): void;
  /** Expand the dock into its full size (tabs + panels visible). */
  expand(): void;
  /** Toggle between the collapsed strip and the full dock. */
  toggle(): void;
}

// ---- Module state ----

/** All registered tab TYPES, keyed by id. */
const defs = new Map<string, RightTabDefinition>();

/** All currently OPEN tabs, keyed by id. */
const openTabs = new Map<string, OpenTab>();

/** Id of the active tab, or null when none is open. */
let activeId: string | null = null;

/** Guards initRightWorkspace() against double initialization. */
let initialized = false;

/**
 * Whether the dock is currently COLLAPSED into a thin strip pinned to the far
 * right of the window. When true, only the extend button is visible; the full
 * dock (header + panels) is hidden via the 'collapsed' class. Toggled by
 * collapseRightWorkspace() / expandRightWorkspace().
 */
let collapsed = false;

// ---- Static element references (resolved in initRightWorkspace) ----
let rightEl: HTMLElement | null = null;
let tabsEl: HTMLElement | null = null;
let panelsEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;

/** Default dock width in px, used until the user resizes it. */
const DEFAULT_WIDTH = 380;
/** Minimum dock width in px. */
const MIN_WIDTH = 240;
/** Absolute upper bound for the dock width in px. The LIVE limit is usually
 *  smaller: the dock may only grow until the LEFT column keeps its minimum
 *  share of the split (see LEFT_MIN_FRACTION). Raised so the dock can be
 *  dragged much wider than before. */
const MAX_WIDTH = 1600;
/** Fraction of the main split width that the LEFT (chat) column always keeps
 *  while the dock is resized. 0.30 => the dock can grow until the chat column
 *  is left with 30% (so the dock's far-left limit is 70% of the split). */
const LEFT_MIN_FRACTION = 0.30;

/**
 * The dock width expressed as a FRACTION of the split container's width. This
 * is the source of truth for the dock's size: the px value written to
 * --right-width is always derived from it (rightFraction * splitWidth), so the
 * dock keeps the SAME show percentage whenever the main window (and therefore
 * the split) is resized. Updated by the drag gesture and seeded at init.
 */
let rightFraction = 1 / 3;

/**
 * Measure the split container (the dock's parent, #main) width in px, falling
 * back to the window width when the parent is unavailable or not laid out.
 */
function getSplitWidth(el: HTMLElement): number {
  const splitEl = el.parentElement;
  return splitEl && splitEl.clientWidth > 0 ? splitEl.clientWidth : window.innerWidth;
}

/**
 * Live upper bound (px) for the dock width: the dock may grow only until the
 * LEFT (chat) column is left with at least LEFT_MIN_FRACTION of the split.
 */
function getUpperWidth(splitWidth: number): number {
  return Math.min(MAX_WIDTH, splitWidth * (1 - LEFT_MIN_FRACTION));
}

/**
 * Write --right-width from rightFraction, clamped to the current bounds. Called
 * at init, while dragging (after updating the fraction) and on window resize.
 */
function applyRightWidth(): void {
  if (!rightEl) return;
  const splitWidth = getSplitWidth(rightEl);
  if (splitWidth <= 0) return;
  const upper = getUpperWidth(splitWidth);
  // Keep the fraction inside the allowed range even on very narrow windows, so
  // the dock never collapses below MIN_WIDTH nor squeezes the chat column past
  // LEFT_MIN_FRACTION.
  rightFraction = Math.min(Math.max(rightFraction, MIN_WIDTH / splitWidth), upper / splitWidth);
  const clamped = Math.round(rightFraction * splitWidth);
  rightEl.style.setProperty('--right-width', clamped + 'px');
}

/**
 * Re-apply the dock's current show percentage after the main window is resized.
 * Exposed so the renderer can call it from a window 'resize' listener.
 */
export function handleRightWorkspaceResize(): void {
  applyRightWidth();
}

/**
 * Show the 'no tabs are open' hint in the panels area. It is kept as a single
 * element created on demand and shown only while no tab is open.
 */
function ensureEmptyHint(): HTMLElement {
  if (!emptyEl) {
    emptyEl = document.createElement('div');
    emptyEl.className = 'right-empty';
    emptyEl.textContent =
      'No panel open. Click a tab above (Logs / Files) or use the workspace buttons to open one.';
  }
  return emptyEl;
}

/** Show/hide the empty hint depending on whether any tab is open. */
function updateEmptyState(): void {
  if (!panelsEl) return;
  if (openTabs.size === 0) {
    panelsEl.appendChild(ensureEmptyHint());
  } else if (emptyEl && emptyEl.parentElement === panelsEl) {
    emptyEl.remove();
  }
}

/** Re-order the tab strip so tabs appear by (order, title, id). */
function sortTabStrip(): void {
  if (!tabsEl) return;
  const ordered = Array.from(openTabs.values()).sort((a, b) => {
    const oa = a.def.order ?? 100;
    const ob = b.def.order ?? 100;
    if (oa !== ob) return oa - ob;
    return a.def.title.localeCompare(b.def.title);
  });
  for (const t of ordered) {
    tabsEl.appendChild(t.tabEl);
  }
}

/** Apply the active/inactive visual state to every open tab. */
function renderActiveState(): void {
  for (const [id, t] of openTabs) {
    const isActive = id === activeId;
    t.tabEl.classList.toggle('active', isActive);
    t.panel.classList.toggle('hidden', !isActive);
  }
}

/** Activate an open tab by id (no-op if not open). */
function setActive(id: string): void {
  if (!openTabs.has(id)) return;
  if (activeId === id) return;

  const prev = activeId ? openTabs.get(activeId) : null;
  if (prev && prev.instance && prev.instance.onHide) {
    try {
      prev.instance.onHide();
    } catch (e) {
      console.error('[rightWorkspace] onHide failed for', prev.def.id, e);
    }
  }

  activeId = id;
  renderActiveState();

  const next = openTabs.get(id);
  if (next && next.instance && next.instance.onShow) {
    try {
      next.instance.onShow();
    } catch (e) {
      console.error('[rightWorkspace] onShow failed for', next.def.id, e);
    }
  }

  // Make sure the dock is visible whenever a tab is activated.
  showDock();
}

/** Show the dock. Also EXPANDS it so any panel show brings the full dock out. */
function showDock(): void {
  if (rightEl) rightEl.classList.remove('hidden');
  // Showing the dock must reveal its content, so clear any collapsed state.
  // Guarded so it never recurses: expandRightWorkspace() does not call showDock().
  if (collapsed) expandRightWorkspace();
}

/** Hide the dock. */
function hideDock(): void {
  if (rightEl) rightEl.classList.add('hidden');
}

/**
 * Minimize the dock into a thin strip pinned to the far RIGHT of the window,
 * leaving only the extend button visible. The full dock (header + panels) is
 * kept in the DOM but hidden via the 'collapsed' class, so open tabs and their
 * state are preserved and expanding is instant.
 *
 * Deliberately does NOT call showDock(): collapsing is an internal size change,
 * not a visibility toggle, and showDock() would expand it again.
 */
export function collapseRightWorkspace(): void {
  if (!rightEl) return;
  collapsed = true;
  rightEl.classList.add('collapsed');
}

/**
 * Expand the dock from the collapsed strip back to its full width (the width
 * derived from rightFraction). Re-applies --right-width so the restored size
 * matches the current window. Deliberately does NOT call showDock() to avoid
 * mutual recursion (showDock() calls this when collapsed).
 */
export function expandRightWorkspace(): void {
  if (!rightEl) return;
  collapsed = false;
  rightEl.classList.remove('collapsed');
  // Restore the width from the retained fraction (handles a resized window).
  applyRightWidth();
}

/** Toggle between the collapsed strip and the full dock. */
export function toggleRightWorkspace(): void {
  if (collapsed) expandRightWorkspace();
  else collapseRightWorkspace();
}

/** Register (or replace) a tab TYPE. */
export function registerRightTab(def: RightTabDefinition): void {
  if (!def || !def.id) {
    console.error('[rightWorkspace] registerRightTab requires a definition with an id');
    return;
  }
  defs.set(def.id, def);
}

/** Whether the dock currently has the given tab open. */
export function isRightTabOpen(id: string): boolean {
  return openTabs.has(id);
}

/**
 * Open a registered tab type. On first open the tab's panel is created and its
 * mount() is called; afterwards it is merely re-activated. Unknown ids log an
 * error and do nothing.
 */
export function openRightTab(id: string): void {
  if (!initialized) initRightWorkspace();

  const existing = openTabs.get(id);
  if (existing) {
    setActive(id);
    return;
  }

  const def = defs.get(id);
  if (!def) {
    console.error('[rightWorkspace] no tab type registered for id', id);
    return;
  }
  if (!panelsEl || !tabsEl) {
    console.error('[rightWorkspace] dock is not ready');
    return;
  }

  // ---- Panel ----
  const panel = document.createElement('div');
  panel.className = 'right-panel';
  panel.dataset.rightTab = id;
  panelsEl.appendChild(panel);

  // ---- Tab element ----
  const tabEl = document.createElement('div');
  tabEl.className = 'right-tab';
  tabEl.dataset.rightTab = id;

  const label = document.createElement('span');
  label.className = 'right-tab-label';
  label.textContent = (def.icon ? def.icon + ' ' : '') + def.title;
  tabEl.appendChild(label);

  // Per-tab close (×) button removed: the Files and Logs tabs no longer show
  // a close control in the tab strip. (A tab can still be closed
  // programmatically via closeRightTab if ever needed.)

  tabEl.addEventListener('click', () => setActive(id));
  tabsEl.appendChild(tabEl);

  openTabs.set(id, { def, panel, tabEl, instance: null });

  // ---- Mount the tab content ----
  let instance: RightTabInstance | null = null;
  try {
    const ctx: RightTabContext = {
      container: panel,
      api: getRightWorkspaceApi(),
      activate: () => setActive(id),
      close: () => closeRightTab(id),
    };
    const result = def.mount(ctx);
    if (result) {
      instance = result;
      if (result.el && !result.el.parentElement) {
        panel.appendChild(result.el);
      }
    }
  } catch (e) {
    console.error('[rightWorkspace] mount failed for', id, e);
    const errEl = document.createElement('div');
    errEl.className = 'right-empty';
    errEl.textContent = 'This panel failed to load: ' + (e instanceof Error ? e.message : String(e));
    panel.appendChild(errEl);
  }

  const open = openTabs.get(id);
  if (open) open.instance = instance;

  sortTabStrip();
  updateEmptyState();
  setActive(id);
}

/** Close an open tab, disposing its instance and removing its DOM. */
export function closeRightTab(id: string): void {
  const t = openTabs.get(id);
  if (!t) return;

  if (t.instance && t.instance.dispose) {
    try {
      t.instance.dispose();
    } catch (e) {
      console.error('[rightWorkspace] dispose failed for', id, e);
    }
  }

  t.panel.remove();
  t.tabEl.remove();
  openTabs.delete(id);

  if (activeId === id) {
    // Activate the next available tab, if any.
    const next = Array.from(openTabs.keys()).sort((a, b) => {
      const oa = openTabs.get(a)?.def.order ?? 100;
      const ob = openTabs.get(b)?.def.order ?? 100;
      return oa - ob;
    })[0];
    activeId = null;
    if (next) {
      setActive(next);
    } else {
      renderActiveState();
    }
  }

  updateEmptyState();

  // Hide the dock entirely once the last tab is closed.
  if (openTabs.size === 0) hideDock();
}

/** Refresh one open tab (by id) or the active tab when id is omitted. */
export function refreshRightTab(id?: string): void {
  const target = id ?? activeId;
  if (!target) return;
  const t = openTabs.get(target);
  if (t && t.instance && t.instance.refresh) {
    try {
      t.instance.refresh();
    } catch (e) {
      console.error('[rightWorkspace] refresh failed for', target, e);
    }
  }
}

/** Refresh the active tab. */
export function refreshActiveRightTab(): void {
  refreshRightTab();
}

/** Build the public API object (also exposed as window.rightWorkspace). */
export function getRightWorkspaceApi(): RightWorkspaceApi {
  return {
    registerTab: registerRightTab,
    openTab: openRightTab,
    closeTab: closeRightTab,
    refreshTab: refreshRightTab,
    refreshActiveTab: refreshActiveRightTab,
    isOpen: isRightTabOpen,
    show: showDock,
    hide: hideDock,
    collapse: collapseRightWorkspace,
    expand: expandRightWorkspace,
    toggle: toggleRightWorkspace,
  };
}

/**
 * Make the dock resizable by dragging its left-edge grip. Only the width is
 * affected (the --right-width custom property on #right-workspace). The gesture
 * runs on window-level mousemove/mouseup so it survives the pointer leaving the
 * grip, non-left buttons are ignored, and text selection is suppressed during
 * the drag.
 */
function makeResizable(el: HTMLElement, handle: HTMLElement): void {
  let startX = 0;
  let startWidth = 0;
  let resizing = false;

  const onMove = (ev: MouseEvent): void => {
    if (!resizing) return;
    // Dragging the LEFT edge: moving left GROWS the dock, so subtract delta.
    const next = startWidth - (ev.clientX - startX);

    // Live upper bound: the dock may grow only until the LEFT (main/chat)
    // column is left with at least LEFT_MIN_FRACTION of the split width. The
    // split is the dock's parent (#main) when available, else the window.
    const splitWidth = getSplitWidth(el);
    const upper = getUpperWidth(splitWidth);

    const clamped = Math.min(Math.max(next, MIN_WIDTH), upper);
    // Record the new size as a FRACTION of the split width so the SAME show
    // percentage is re-applied whenever the main window is later resized.
    rightFraction = clamped / splitWidth;
    el.style.setProperty('--right-width', clamped + 'px');
  };

  const onUp = (): void => {
    if (!resizing) return;
    resizing = false;
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  handle.addEventListener('mousedown', (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    startX = ev.clientX;
    startWidth = el.getBoundingClientRect().width;
    resizing = true;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    ev.preventDefault();
  });
}

/**
 * Initialize the dock: resolve the static elements, wire the resize grip, seed
 * the default width, and expose the public API on window.rightWorkspace so
 * external/plugin tab types can register themselves. Idempotent.
 */
export function initRightWorkspace(): void {
  if (initialized) return;

  rightEl = document.getElementById('right-workspace');
  tabsEl = document.getElementById('right-tabs');
  panelsEl = document.getElementById('right-panels');

  if (!rightEl || !tabsEl || !panelsEl) {
    console.error('[rightWorkspace] dock elements not found in the DOM; skipping init');
    return;
  }

  // Default the dock to roughly 1/3 of the split width. The width is stored
  // as a FRACTION (rightFraction) and applied via applyRightWidth(), so the
  // SAME show percentage is preserved when the main window is resized.
  rightFraction = 1 / 3;
  applyRightWidth();

  const grip = rightEl.querySelector('.right-workspace-resizer') as HTMLElement | null;
  if (grip) makeResizable(rightEl, grip);

  // ---- Dock header with a close (x) button -------------------------------
  // Wrap the tab strip in a header row and add a close button so the whole
  // right workspace can be dismissed. Closing only HIDES the dock (open tabs
  // and their DOM are preserved), so it can be re-opened at any time via the
  // workspace 'Logs' / 'Files' buttons (openRightTab -> setActive -> showDock).
  const dockInner = rightEl.querySelector('.right-dock-inner');
  if (dockInner && !rightEl.querySelector('.right-dock-close')) {
    const header = document.createElement('div');
    header.className = 'right-dock-header';

    // Move the existing tab strip into the header (keeps its element/refs).
    dockInner.insertBefore(header, tabsEl);
    header.appendChild(tabsEl);

    // Header control pinned to the far right of the tab bar: the collapse
    // (minimize) button, which shrinks the dock to the far-right strip. The
    // old close (x) button was removed; hiding is no longer offered here.
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'right-dock-collapse';
    collapseBtn.title = 'Minimize panel';
    collapseBtn.setAttribute('aria-label', 'Minimize panel');
    collapseBtn.textContent = '\u00bb';
    collapseBtn.addEventListener('click', () => collapseRightWorkspace());
    header.appendChild(collapseBtn);
  }

  // ---- Far-right EXTEND button (visible only while collapsed) ------------
  // A thin strip button pinned to the far right of the window, showing a
  // left-pointing chevron. Clicking it expands the dock back to its full size
  // (expandRightWorkspace). It is hidden unless the dock carries 'collapsed'.
  if (!rightEl.querySelector('.right-expand')) {
    const expandBtn = document.createElement('button');
    expandBtn.className = 'right-expand';
    expandBtn.title = 'Show panel';
    expandBtn.setAttribute('aria-label', 'Show panel');
    expandBtn.textContent = '\u00ab';
    expandBtn.addEventListener('click', () => expandRightWorkspace());
    rightEl.appendChild(expandBtn);
  }


  updateEmptyState();
  initialized = true;

  // Expose the API so plugins can register additional tab types.
  (window as unknown as { rightWorkspace?: RightWorkspaceApi }).rightWorkspace =
    getRightWorkspaceApi();

  // Start COLLAPSED by default: the app loads with the dock minimized to the
  // thin far-right strip; the user expands it via the extend button.
  collapseRightWorkspace();
}

/** Public API is also reachable via window.rightWorkspace after init. */
declare global {
  interface Window {
    rightWorkspace?: RightWorkspaceApi;
  }
}

export default getRightWorkspaceApi;

/**
 * logView.ts - the inline application-log viewer for the RIGHT-side dock.
 *
 * This is the dock-hosted replacement for the old FLOATING log window
 * (src/logsWindow.ts). Instead of hovering above the chat window, the log now
 * lives in a normal dock tab on the right side of the workspace.
 *
 * It reuses the SAME main-process tail bridge used before:
 *   window.axle.getLogPath()    -> the file being followed
 *   window.axle.startLogTail()  -> main emits the whole file, then live chunks
 *   window.axle.stopLogTail()   -> stop following
 *   window.axle.onLogData(cb)   -> live data / error / truncate events
 *
 * Presentation lives in src/styles.css (.log-view, .log-view-header,
 * .log-view-title, .log-view-path, .log-view-body).
 *
 * The module exports:
 *   - buildLogView(ctx): mounts the tab content and returns a RightTabInstance
 *     (used as the dock's tab definition mount() ).
 *   - refreshLog():       re-tails from the start (fresh full content).
 *   - stopLogView():      stops the tail (called when the tab is disposed).
 *   - LOGS_TAB_ID:        the dock tab id for this view.
 */

import type { RightTabContext, RightTabInstance } from './rightWorkspace';

/** The dock tab id used to open this view. */
export const LOGS_TAB_ID = 'logs';

/** Payload pushed from the main process on the 'axle:logData' channel. */
interface LogDataPayload {
  type: 'data' | 'error' | 'truncate';
  data: string;
}

/** Bridge methods used by this view (subset of window.axle). */
interface LogsBridge {
  getLogPath(): Promise<string>;
  startLogTail(): Promise<string>;
  stopLogTail(): Promise<boolean>;
  onLogData(cb: (payload: LogDataPayload) => void): () => void;
}

interface AxleWithLogs {
  axle?: Partial<LogsBridge>;
}

/** Distance (px) from the bottom edge within which the view counts as pinned. */
const PIN_THRESHOLD = 4;

// ---- Module state (the view is a single instance inside its dock tab) ----
let bodyEl: HTMLElement | null = null;
let pathLabel: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
let started = false;

/** Whether the view is parked at (or very near) the bottom of the log. */
function isPinnedToBottom(): boolean {
  if (!bodyEl) return true;
  return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight <= PIN_THRESHOLD;
}

/** Keep the log body scrolled to its bottom edge so the newest line is visible. */
function scrollToBottom(): void {
  if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
}

/** Reflect the followed file path in the header. */
function setPath(p: string): void {
  if (pathLabel) {
    pathLabel.textContent = p;
    pathLabel.title = p;
  }
}

// ---- Copy-only context menu ------------------------------------------------
// The log body is READ-ONLY, so the only meaningful action is Copy. A plain
// Chromium page has no built-in context menu, and we deliberately do NOT wire
// Electron's full edit menu (which would also expose Cut/Paste/Select-All) --
// the requirement is COPY ONLY. This bespoke menu therefore offers exactly one
// item. It is created lazily and appended to <body> (position: fixed) so it
// never touches the log body, its live tail, or the pin-to-bottom scrolling.
let copyMenuEl: HTMLElement | null = null;
let copyMenuCleanup: (() => void) | null = null;

/** Remove the copy menu and detach its dismissal listeners. */
function hideCopyMenu(): void {
  if (copyMenuCleanup) {
    copyMenuCleanup();
    copyMenuCleanup = null;
  }
  if (copyMenuEl && copyMenuEl.parentNode) {
    copyMenuEl.parentNode.removeChild(copyMenuEl);
  }
  copyMenuEl = null;
}

/** Copy the current selection to the clipboard (async API, execCommand fallback). */
function copySelection(): void {
  const sel = window.getSelection ? window.getSelection() : null;
  const text = sel ? sel.toString() : '';
  if (!text) return;

  const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
  if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    void nav.clipboard.writeText(text);
    return;
  }

  // Fallback for contexts where the async Clipboard API is unavailable.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}

/** Show a one-item, copy-only context menu at the given viewport coordinates. */
function showCopyMenu(x: number, y: number): void {
  hideCopyMenu();

  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || !sel.toString()) {
    return; // Nothing selected -> no menu.
  }

  const menu = document.createElement('div');
  menu.className = 'log-copy-menu';

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'log-copy-menu-item';
  item.textContent = 'Copy';
  item.addEventListener('click', () => {
    copySelection();
    hideCopyMenu();
  });

  menu.appendChild(item);
  document.body.appendChild(menu);

  // Position at the pointer, then clamp so the menu stays inside the viewport.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  copyMenuEl = menu;

  // Dismiss on outside click, Escape, resize, or any log scroll.
  const onDown = (ev: MouseEvent): void => {
    if (copyMenuEl && !copyMenuEl.contains(ev.target as Node)) hideCopyMenu();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') hideCopyMenu();
  };
  const onAway = (): void => hideCopyMenu();
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onAway, true);
  document.addEventListener('scroll', onAway, true);

  copyMenuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onAway, true);
    document.removeEventListener('scroll', onAway, true);
  };
}

/**
 * Subscribe to live log data (once) and start the tail. The subscription is
 * installed BEFORE startLogTail so no chunk is missed in between.
 */
function ensureStarted(): void {
  const axle = (window as unknown as AxleWithLogs).axle;
  if (!bodyEl) return;

  if (!axle || typeof axle.onLogData !== 'function' || typeof axle.startLogTail !== 'function') {
    bodyEl.textContent = 'Log viewer is unavailable: the application bridge is not ready.';
    return;
  }

  // Install the live-data subscription exactly once.
  if (!unsubscribe) {
    unsubscribe = axle.onLogData((payload: LogDataPayload) => {
      if (!bodyEl) return;
      if (payload.type === 'truncate') {
        // Log rotated/truncated: the main process replays it from the start.
        bodyEl.textContent = '';
        return;
      }

      // Capture the pinned state BEFORE mutating content (textContent += resets
      // scrollTop), so we can restore the reading position when scrolled up.
      const pinned = isPinnedToBottom();
      const prevScrollTop = bodyEl.scrollTop;

      // Append the chunk as its own text node rather than reassigning
      // textContent. Reassigning textContent REPLACES the element's entire
      // text node on every live chunk, which destroys any in-progress
      // selection -- so a selected strip could never stay selected (let alone
      // be copied) while the log was actively tailing. appendChild leaves the
      // existing nodes untouched, so the user's selection survives updates.
      const chunk =
        payload.type === 'error'
          ? '[log error] ' + payload.data + '\n'
          : payload.data;
      bodyEl.appendChild(document.createTextNode(chunk));

      if (pinned) {
        scrollToBottom();
      } else {
        bodyEl.scrollTop = prevScrollTop;
      }
    });
  }

  // Show which file is being followed.
  if (typeof axle.getLogPath === 'function') {
    axle
      .getLogPath()
      .then((p: string) => setPath(p))
      .catch((): undefined => undefined);
  }

  axle
    .startLogTail()
    .then((p: string) => {
      started = true;
      if (p) setPath(p);
      scrollToBottom();
    })
    .catch((err: Error) => {
      if (bodyEl) {
        bodyEl.textContent += '[log error] ' + err.message + '\n';
        scrollToBottom();
      }
    });
}

/**
 * Build the 'Logs' dock tab content inside ctx.container and return its
 * lifecycle instance. Called once by the dock when the tab is first opened.
 */
export function buildLogView(ctx: RightTabContext): RightTabInstance {
  const root = document.createElement('div');
  root.className = 'log-view';

  const header = document.createElement('div');
  header.className = 'log-view-header';

  const title = document.createElement('span');
  title.className = 'log-view-title';
  title.textContent = 'Application Logs';

  pathLabel = document.createElement('span');
  pathLabel.className = 'log-view-path';
  pathLabel.textContent = '';

  // A small action to force a fresh re-read of the whole log.
  const refreshBtn = document.createElement('button');
  // Reuse the Files tab's refresh button styling ('files-refresh') so the two
  // refresh buttons look identical instead of using the old 'files-view-refresh'
  // class (whose styling was inconsistent).
  refreshBtn.className = 'files-refresh';
  refreshBtn.textContent = '\u21bb';
  refreshBtn.title = 'Reload the log from the start';
  refreshBtn.addEventListener('click', () => refreshLog());

  header.appendChild(title);
  header.appendChild(pathLabel);
  header.appendChild(refreshBtn);

  bodyEl = document.createElement('div');
  bodyEl.className = 'log-view-body';

  // COPY-ONLY context menu. The log is read-only, so the sole action offered is
  // Copy. We only intercept the event when the user actually has a selection;
  // otherwise we leave the default alone. Registered once per build.
  bodyEl.addEventListener('contextmenu', (ev: MouseEvent) => {
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && sel.toString()) {
      ev.preventDefault();
      showCopyMenu(ev.clientX, ev.clientY);
    }
  });

  root.appendChild(header);
  root.appendChild(bodyEl);
  ctx.container.appendChild(root);

  // Start tailing as soon as the tab is created.
  ensureStarted();

  return {
    el: root,
    onShow: () => {
      // The Logs tab is (re)activated. Its content was CLEARED while the tab
      // was inactive (see onHide below), so load the log again. When the tail
      // is not running, ensureStarted() re-installs the live-data subscription
      // and replays the whole file via the tail bridge (fresh full content);
      // otherwise just keep the view pinned to the newest line.
      if (!started) {
        ensureStarted();
      } else {
        scrollToBottom();
      }
    },
    onHide: () => {
      // The Logs tab is NO LONGER active: stop the live tail and clear the
      // visible log content so an inactive tab shows nothing. The DOM refs
      // (bodyEl / pathLabel) are kept so onShow can load the log again.
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      const axle = (window as unknown as AxleWithLogs).axle;
      if (axle && typeof axle.stopLogTail === 'function') {
        void axle.stopLogTail();
      }
      hideCopyMenu();
      started = false;
      if (bodyEl) bodyEl.textContent = '';
      if (pathLabel) {
        pathLabel.textContent = '';
        pathLabel.title = '';
      }
    },
    refresh: () => refreshLog(),
    dispose: () => stopLogView(),
  };
}

/** Restart the tail so the whole log is re-read from the beginning. */
export function refreshLog(): void {
  // Tear down the previous follower first so we do not double-subscribe.
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  started = false;
  if (bodyEl) bodyEl.textContent = '';
  ensureStarted();
}

/** Stop the tail and release the subscription (called on tab dispose). */
export function stopLogView(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  const axle = (window as unknown as AxleWithLogs).axle;
  if (axle && typeof axle.stopLogTail === 'function') {
    void axle.stopLogTail();
  }
  // Tear down any open copy menu so it (and its listeners) do not linger.
  hideCopyMenu();
  bodyEl = null;
  pathLabel = null;
  started = false;
}

/** Whether the log tail is currently running for this view. */
export function isLogViewStarted(): boolean {
  return started;
}

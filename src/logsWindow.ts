/**
 * logsWindow.ts - a NON-MODAL floating log viewer for the renderer.
 *
 * The 'Logs' button on the workspace button bar opens this panel. It floats
 * above the chat window (position: fixed, high z-index) but stays non-modal, so
 * the workspace underneath remains fully usable.
 *
 * The panel:
 *   - occupies 1/3 of the screen width;
 *   - uses the SAME height as the chat log window (measured at open time);
 *   - always shows the ENTIRE content of the log file and then follows it
 *     automatically, because the actual `tail -f` runs in the MAIN process
 *     (src/core/tail.ts) and streams over the window.axle bridge;
 *   - follows the newest line (the 'cursor') ONLY while the user is parked at
 *     the bottom; if the user scrolls up to read earlier text, new chunks are
 *     appended without stealing their position, so the scrollback stays stable;
 *   - has a close (x) button that stops the tail and removes the panel.
 *
 * All presentation lives in src/styles.css (.logs-window,
 * .logs-window-header, .logs-window-title, .logs-window-path,
 * .logs-window-close, .logs-window-body). The ONLY values set from code are the
 * two dynamic geometry custom properties (--logs-width / --logs-height), since
 * the panel width and the chat-log height can only be measured at runtime.
 *
 * The log file path is NOT hard-coded here: it is obtained from the main
 * process (window.axle.getLogPath()), which reads it from src/core/logger.ts.
 */

/** Payload pushed from the main process on the 'axle:logData' channel. */
interface LogDataPayload {
  type: 'data' | 'error' | 'truncate';
  data: string;
}

/**
 * The extra bridge methods used by this window. They are declared here so the
 * module compiles even if the global Window augmentation is updated later.
 */
interface LogsBridge {
  getLogPath(): Promise<string>;
  startLogTail(): Promise<string>;
  stopLogTail(): Promise<boolean>;
  onLogData(cb: (payload: LogDataPayload) => void): () => void;
}

interface AxleWithLogs {
  axle?: Partial<LogsBridge>;
}

/** Currently mounted panel, if any. Only one may exist at a time. */
let panel: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
let resizeHandler: (() => void) | null = null;

/** Reference to the scrollable log body, used to keep it pinned to the bottom. */
let bodyEl: HTMLElement | null = null;

/** Distance (px) from the bottom edge within which the view counts as pinned. */
const PIN_THRESHOLD = 4;

/**
 * Whether the user is currently parked at (or very near) the bottom of the
 * log. Only then should newly appended content pull the view down to the last
 * line; if the user has scrolled up to read earlier lines, their position must
 * be left untouched.
 */
function isPinnedToBottom(): boolean {
  if (!bodyEl) {
    return true;
  }
  return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight <= PIN_THRESHOLD;
}

/**
 * Keep the log body scrolled to its bottom edge so the newest line is visible.
 * Callers only invoke this when the view is meant to follow the live tail.
 */
function scrollToBottom(): void {
  if (bodyEl) {
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
}

/** 1/3 of the screen width, clamped to a sane minimum. */
function panelWidth(): number {
  return Math.max(320, Math.floor(window.innerWidth / 3));
}

/**
 * Height of the chat log window. The `.chat-log` element is a flex child
 * (flex: 1) so it has no fixed pixel height; we therefore measure the visible
 * chat log directly and fall back to a viewport-relative height.
 */
function panelHeight(): number {
  const chatLogs = document.querySelectorAll<HTMLElement>('.chat-log');
  for (const el of Array.from(chatLogs)) {
    const rect = el.getBoundingClientRect();
    if (rect.height > 0) {
      return Math.round(rect.height);
    }
  }
  return Math.max(240, Math.floor(window.innerHeight * 0.6));
}

/**
 * Publish the measured geometry to the stylesheet. src/styles.css consumes
 * these custom properties as
 *   width:  var(--logs-width, 33vw);
 *   height: var(--logs-height, 60vh);
 * so no other inline styling is required.
 */
function applyGeometry(el: HTMLElement): void {
  el.style.setProperty('--logs-width', panelWidth() + 'px');
  el.style.setProperty('--logs-height', panelHeight() + 'px');
}

/** Remove the panel and release every resource. */
function closeLogsWindow(): void {
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }

  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  // Tell the main process to stop following the file.
  const axle = (window as unknown as AxleWithLogs).axle;
  if (axle && typeof axle.stopLogTail === 'function') {
    void axle.stopLogTail();
  }

  if (panel) {
    panel.remove();
    panel = null;
  }
  bodyEl = null;
}

/**
 * Open (or close, when already open) the floating log window.
 * Called by the leftmost 'Logs' button of the workspace button bar.
 */
export function openLogsWindow(): void {
  // Toggle: a second click closes the panel.
  if (panel) {
    closeLogsWindow();
    return;
  }

  const axle = (window as unknown as AxleWithLogs).axle;

  // ---- Panel shell (non-modal: a floating card, NOT a full-screen overlay) ----
  // All appearance comes from the `.logs-window` rule in src/styles.css.
  panel = document.createElement('div');
  panel.className = 'logs-window';
  applyGeometry(panel);

  // ---- Header: title + path + close (x) ----
  const header = document.createElement('div');
  header.className = 'logs-window-header';

  const title = document.createElement('span');
  title.className = 'logs-window-title';
  title.textContent = 'Application Logs';

  const pathLabel = document.createElement('span');
  pathLabel.className = 'logs-window-path';
  pathLabel.textContent = '';
  pathLabel.title = '';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'logs-window-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', () => closeLogsWindow());

  header.appendChild(title);
  header.appendChild(pathLabel);
  header.appendChild(closeBtn);

  // ---- Scrollable, pre-formatted log body ----
  bodyEl = document.createElement('div');
  bodyEl.className = 'logs-window-body';

  panel.appendChild(header);
  panel.appendChild(bodyEl);
  document.body.appendChild(panel);

  // Keep the panel sized like the chat log while the window is resized. Only
  // re-pin to the bottom when the user was already following the tail.
  resizeHandler = () => {
    if (panel) {
      const pinned = isPinnedToBottom();
      applyGeometry(panel);
      if (pinned) {
        scrollToBottom();
      }
    }
  };
  window.addEventListener('resize', resizeHandler);

  // ---- Live content: read the path, then show the whole log and follow it ----
  if (!axle || typeof axle.onLogData !== 'function' || typeof axle.startLogTail !== 'function') {
    bodyEl.textContent = 'Log viewer is unavailable: the application bridge is not ready.';
    return;
  }

  // Subscribe FIRST so no chunk is missed between start and subscription.
  unsubscribe = axle.onLogData((payload: LogDataPayload) => {
    if (!bodyEl) {
      return;
    }
    if (payload.type === 'truncate') {
      // The log was truncated / rotated: the main process replays it from the
      // beginning, so start from a clean slate here as well.
      bodyEl.textContent = '';
      return;
    }

    // Decide up-front whether to follow the tail: appending via textContent
    // replaces the child nodes and resets scrollTop, so capture the pinned
    // state and the current reading position BEFORE mutating the content.
    const pinned = isPinnedToBottom();
    const prevScrollTop = bodyEl.scrollTop;

    if (payload.type === 'error') {
      bodyEl.textContent += '[log error] ' + payload.data + '\n';
    } else {
      // Append the new content.
      bodyEl.textContent += payload.data;
    }

    if (pinned) {
      // The user is watching the live tail: keep the newest line visible.
      scrollToBottom();
    } else {
      // The user has scrolled up to read earlier text: leave their position
      // untouched so new chunks do not yank the view to the last line.
      bodyEl.scrollTop = prevScrollTop;
    }
  });

  // Show which file is being followed, then start tailing. The main process
  // performs an initial full read, so the panel ends up with the ENTIRE log.
  if (typeof axle.getLogPath === 'function') {
    axle
      .getLogPath()
      .then((p: string) => {
        pathLabel.textContent = p;
        pathLabel.title = p;
      })
      .catch((): undefined => undefined);
  }

  axle
    .startLogTail()
    .then((p: string) => {
      if (p) {
        pathLabel.textContent = p;
        pathLabel.title = p;
      }
      // Initial open: start the view at the newest line.
      scrollToBottom();
    })
    .catch((err: Error) => {
      if (bodyEl) {
        bodyEl.textContent += '[log error] ' + err.message + '\n';
        scrollToBottom();
      }
    });
}

export default openLogsWindow;

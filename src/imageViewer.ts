/**
 * imageViewer.ts - the modal image preview opened from the 'Files' tab.
 *
 * Shows a single image. The dialog is sized from the image itself, so a
 * picture that fits the screen opens at its original pixel size (1:1) and a
 * larger one is scaled down proportionally to fit; nothing is ever upscaled.
 * The header offers a maximize/restore button that swaps between the
 * image-sized dialog and the full work area.
 *
 * It deliberately mirrors fileEditor.ts: the same overlay + dialog skeleton,
 * the same header (title + buttons), the same full-path line, Escape /
 * backdrop / close-button dismissal, and an idempotent dispose that removes
 * every listener it adds.
 * The caller supplies the already-fetched bytes as a base64 string plus the
 * MIME type, so the dialog is source-agnostic and serves local files and
 * remote (ssh://) files alike.
 *
 * The data: URI is assembled here rather than through buildImageUri in
 * src/common/common.ts: that module imports fs and ssh2, and this file is
 * renderer code, so importing it would drag node built-ins into the renderer
 * bundle. The encoding is a one-liner, so duplicating it is cheaper than a
 * bundler hazard.
 *
 * Presentation lives in src/workingDir.css (.image-viewer*).
 */

import { buildPathBox } from './pathBox';
import type { PathBoxHandle } from './pathBox';

/** Options accepted by openImageViewer. */
export interface ImageViewerOptions {
  /** Display name shown in the dialog header (for example renderer.ts). */
  fileName: string;
  /** Full path of the file; shown under the title. */
  filePath: string;
  /** MIME type of the image (for example image/png, image/svg+xml). */
  mimeType: string;
  /** Raw image bytes, base64 encoded, as returned by axle.readImageFile. */
  base64: string;
  /**
   * Mount WITHOUT the modal chrome: no dimmed backdrop, no backdrop
   * dismissal, no Escape-to-close, no resize grip and no maximize button.
   * The dialog box itself (header, path line, image surface, footer) is
   * rendered into `parent` as an ordinary block element, which is how the
   * view space in src/viewSpace.ts embeds this same preview inside a tab
   * panel instead of a floating window.
   *
   * An embedded instance is sized by its HOST panel rather than by the image:
   * the picture is contained (never upscaled) inside whatever space the panel
   * gives it, and the footer still reports the natural pixel size.
   */
  embedded?: boolean;
  /**
   * Called exactly once, after the dialog has been detached from the DOM.
   *
   * Used by the view space to remove the tab that owned this instance.
   */
  onClose?: () => void;
  /** Optional mount point; defaults to document.body. */
  parent?: HTMLElement;
}

/** Live handle returned by openImageViewer. */
export interface ImageViewerHandle {
  /** The overlay element (already attached to the DOM). */
  el: HTMLElement;
  /** Remove the dialog and detach every listener it installed. */
  close: () => void;
}

/**
 * Open the modal image preview and return a handle that disposes it.
 *
 * The dialog is appended to the given parent (document.body by default) and
 * closes on Escape, the close button, or a click on the dimmed backdrop.
 *
 * The dialog is sized FROM the image: a picture that fits the screen opens at
 * its original pixel size (1:1), while a larger one is scaled down
 * proportionally to fit and is never upscaled, so a small icon stays small
 * while a large screenshot shrinks to fit. The header carries a
 * maximize/restore button that swaps the dialog between that image-sized
 * window and the full work area, re-fitting the image each way.
 */
export function openImageViewer(options: ImageViewerOptions): ImageViewerHandle {
  const parent = options.parent || document.body;

  // ---- DOM skeleton (mirrors fileEditor.ts) ----
  // An EMBEDDED instance (mounted by the view space) is an ordinary block
  // inside its host panel: the wrapper carries no dimming/backdrop styling and
  // the box is not announced as a modal dialog, because it does not block the
  // rest of the UI. Every guard below keys off this single flag.
  const embedded = options.embedded === true;

  const overlay = document.createElement('div');
  overlay.className = embedded ? 'image-viewer-embed' : 'image-viewer-overlay';

  const dialog = document.createElement('div');
  dialog.className = embedded ? 'image-viewer image-viewer-inline' : 'image-viewer';
  if (!embedded) {
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
  }

  const header = document.createElement('div');
  header.className = 'image-viewer-header';

  const title = document.createElement('span');
  title.className = 'image-viewer-title';
  title.textContent = options.fileName;
  title.title = options.filePath;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'image-viewer-close';
  closeBtn.type = 'button';
  closeBtn.textContent = '\u00d7';
  // An embedded instance ignores Escape (the host window owns the keyboard),
  // so the tooltip must not advertise a shortcut that does nothing.
  closeBtn.title = embedded ? 'Close' : 'Close (Esc)';

  // Maximize / restore toggle, placed left of the close button. The icon is an
  // inline SVG so the two states swap without an icon font, and currentColor
  // keeps it in step with the hover colour set in workingDir.css.
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
  maxBtn.className = 'image-viewer-max';
  maxBtn.type = 'button';

  // The TITLE BAR belongs to the floating dialog only. An embedded instance
  // lives in a view-space tab that already shows the file name and carries its
  // own close marker, so a header would spend a row repeating both - the same
  // treatment src/fileEditor.ts gives its embedded editor. Everything the
  // header hosted is therefore skipped: the name, the maximize toggle
  // (meaningless when pinned in a panel, so onToggleMaximize is never wired)
  // and the close button (the tab own x routes through the same disposeAll).
  // The path line, the image surface and the footer (natural size, zoom
  // percentage and MIME note) are all kept.
  if (!embedded) {
    header.appendChild(title);
    header.appendChild(maxBtn);
    header.appendChild(closeBtn);
  }

  // The path line is the SHARED searchable path box (src/pathBox.ts), the same
  // control the view-space tab bar and the code editor render, so the file path
  // looks and behaves identically on every surface. `pathLine` stays an alias
  // for the box's root element, which keeps the appendChild and the chrome
  // measurements below unchanged.
  const pathBox: PathBoxHandle = buildPathBox({
    path: options.filePath,
    className: 'path-box-inline'
  });
  const pathLine = pathBox.el;

  const surface = document.createElement('div');
  surface.className = 'image-viewer-surface';

  const image = document.createElement('img');
  image.className = 'image-viewer-img';
  image.alt = options.fileName;
  // Hidden until layout() has measured the natural size, so the image never
  // paints once at the stylesheet size and then jumps to the computed one.
  image.style.visibility = 'hidden';
  image.src = 'data:' + options.mimeType + ';base64,' + options.base64;

  surface.appendChild(image);

  // The FOOTER is informational only: the natural-size / zoom readout and the
  // MIME note. It holds no Close/Save/Cancel actions in EITHER mode - every
  // dismissal control (the header x, Escape, the backdrop) belongs to the
  // floating dialog and is already skipped when embedded - so an embedded
  // preview shows no bottom buttons while still reporting the picture's size
  // and any decode failure.
  const footer = document.createElement('div');
  footer.className = 'image-viewer-footer';

  const status = document.createElement('span');
  status.className = 'image-viewer-status';

  const mimeNote = document.createElement('span');
  mimeNote.className = 'image-viewer-mime';
  mimeNote.textContent = options.mimeType;
  mimeNote.title = 'Detected image type';

  footer.appendChild(status);
  footer.appendChild(mimeNote);

  // Bottom-right grip that makes the dialog resizable with the mouse. It is an
  // absolutely positioned child of the dialog (see .image-viewer-resize), so
  // it overlays the footer corner without taking part in the flex column. The
  // gesture itself is wired in onGripMouseDown, modelled on the logs-window
  // grip in src/styles.css and makeResizable in src/rightWorkspace.ts.
  // The grip belongs to the floating dialog only: an embedded instance is
  // sized by the view-space resizer, so the corner grip is skipped entirely.
  const resizeGrip = document.createElement('div');
  resizeGrip.className = 'image-viewer-resize';
  resizeGrip.title = 'Drag to resize';

  // The header ROW is skipped as well, not merely left empty: the stylesheet
  // gives .image-viewer-header a height, padding and a bottom border, so an
  // empty header would still paint a stray strip where the title bar was.
  if (!embedded) dialog.appendChild(header);
  dialog.appendChild(pathLine);
  dialog.appendChild(surface);
  dialog.appendChild(footer);
  if (!embedded) dialog.appendChild(resizeGrip);
  overlay.appendChild(dialog);
  parent.appendChild(overlay);

  // ---- State ----
  let closed = false;

  const setStatus = (text: string, isError: boolean): void => {
    status.textContent = text;
    status.className = isError ? 'image-viewer-status error' : 'image-viewer-status';
  };

  // ---- Sizing ----
  // The dialog is sized FROM the image, so a picture that fits the screen is
  // shown at its original pixel size (1:1). A larger one is scaled down
  // proportionally to fit and is never upscaled. Maximizing pins the dialog to
  // the work area (see .image-viewer.maximized) and the same fit logic then
  // applies to the larger box.
  const MIN_DIALOG_W = 420;
  const MIN_DIALOG_H = 300;
  const DIALOG_MARGIN = 24;

  let maximized = false;
  let failed = false;
  let resizeTimer: number | null = null;

  // Set once the user has dragged the bottom-right grip: from then on the
  // image-derived sizing in layout() no longer wins, so a later fit pass
  // cannot undo the size the user chose. onToggleMaximize() clears it so
  // maximizing and restoring still re-derive the image-sized window.
  let userSized = false;

  // Active drag gesture state (see onGripMouseDown).
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  /** Space the dialog spends on everything but the image itself. */
  const chromeSize = (): { horizontal: number; vertical: number } => {
    const borderX = dialog.offsetWidth - dialog.clientWidth;
    const borderY = dialog.offsetHeight - dialog.clientHeight;
    const surfaceStyle = window.getComputedStyle(surface);
    const padX =
      (parseFloat(surfaceStyle.paddingLeft) || 0) +
      (parseFloat(surfaceStyle.paddingRight) || 0);
    const padY =
      (parseFloat(surfaceStyle.paddingTop) || 0) +
      (parseFloat(surfaceStyle.paddingBottom) || 0);
    // The shared path box carries a vertical MARGIN (the .path-box-inline
    // modifier insets it from the panel edges, like the Files tab's path row),
    // and offsetHeight excludes margins. Counting only the height would size the
    // dialog a few pixels short and clip the picture, so the computed vertical
    // margins are measured here and added to the chrome.
    const pathStyle = window.getComputedStyle(pathLine);
    const pathMarginY =
      (parseFloat(pathStyle.marginTop) || 0) +
      (parseFloat(pathStyle.marginBottom) || 0);
    return {
      horizontal: borderX + padX,
      vertical:
        borderY +
        padY +
        header.offsetHeight +
        pathLine.offsetHeight +
        pathMarginY +
        footer.offsetHeight
    };
  };

  /**
   * Size the dialog from the image, then scale the image down only when it
   * still exceeds the space left inside the dialog.
   */
  const layout = (): void => {
    if (failed) return;
    const natW = image.naturalWidth;
    const natH = image.naturalHeight;
    if (natW <= 0 || natH <= 0) {
      // No intrinsic size (an SVG without width/height, for instance). The
      // image is never scaled up, so let the stylesheet contain it instead of
      // leaving it hidden forever.
      image.style.maxWidth = '100%';
      image.style.maxHeight = '100%';
      image.style.width = '';
      image.style.height = '';
      image.style.visibility = 'visible';
      return;
    }

    // EMBEDDED: the host panel owns the geometry, so there is no dialog size
    // to derive and no grip/maximize state to honour. Measure the surface the
    // panel gives us and fit the picture inside it, never above 1:1 so a small
    // icon stays small while a large screenshot shrinks to fit. The panel is
    // already visible when the viewer mounts (the view space shows the tab
    // first), so clientWidth/clientHeight are meaningful here.
    if (embedded) {
      const boxStyle = window.getComputedStyle(surface);
      const availW = Math.max(
        1,
        surface.clientWidth -
          (parseFloat(boxStyle.paddingLeft) || 0) -
          (parseFloat(boxStyle.paddingRight) || 0)
      );
      const availH = Math.max(
        1,
        surface.clientHeight -
          (parseFloat(boxStyle.paddingTop) || 0) -
          (parseFloat(boxStyle.paddingBottom) || 0)
      );
      const fit = Math.min(1, availW / natW, availH / natH);
      image.style.maxWidth = 'none';
      image.style.maxHeight = 'none';
      image.style.width = Math.round(natW * fit) + 'px';
      image.style.height = Math.round(natH * fit) + 'px';
      image.style.visibility = 'visible';
      const naturalSize = natW + ' \u00d7 ' + natH;
      setStatus(
        fit < 1
          ? naturalSize + ' \u00b7 ' + Math.round(fit * 100) + '%'
          : naturalSize + ' \u00b7 1:1',
        false
      );
      return;
    }

    const chrome = chromeSize();

    if (maximized) {
      // The stylesheet owns the geometry of the maximized dialog.
      dialog.style.width = '';
      dialog.style.height = '';
    } else if (!userSized) {
      // A size the user dragged wins over the image-derived one, so a later
      // fit pass cannot undo it. The surface measurement and the scale math
      // below still run either way, so the picture keeps fitting.
      const availW = Math.max(MIN_DIALOG_W, window.innerWidth - DIALOG_MARGIN * 2);
      const availH = Math.max(MIN_DIALOG_H, window.innerHeight - DIALOG_MARGIN * 2);
      const width = Math.max(MIN_DIALOG_W, Math.min(natW + chrome.horizontal, availW));
      const height = Math.max(MIN_DIALOG_H, Math.min(natH + chrome.vertical, availH));
      dialog.style.width = Math.round(width) + 'px';
      dialog.style.height = Math.round(height) + 'px';
    }

    // Measure what is genuinely left for the image after the dialog chrome.
    const surfaceStyle = window.getComputedStyle(surface);
    const boxW = Math.max(
      1,
      surface.clientWidth -
        (parseFloat(surfaceStyle.paddingLeft) || 0) -
        (parseFloat(surfaceStyle.paddingRight) || 0)
    );
    const boxH = Math.max(
      1,
      surface.clientHeight -
        (parseFloat(surfaceStyle.paddingTop) || 0) -
        (parseFloat(surfaceStyle.paddingBottom) || 0)
    );

    // Never above 1: a small icon stays at its natural size.
    const scale = Math.min(1, boxW / natW, boxH / natH);

    image.style.maxWidth = 'none';
    image.style.maxHeight = 'none';
    image.style.width = Math.round(natW * scale) + 'px';
    image.style.height = Math.round(natH * scale) + 'px';
    image.style.visibility = 'visible';

    const size = natW + ' \u00d7 ' + natH;
    setStatus(
      scale < 1 ? size + ' \u00b7 ' + Math.round(scale * 100) + '%' : size + ' \u00b7 1:1',
      false
    );
  };

  // ---- Lifecycle ----
  const disposeAll = (): void => {
    if (closed) return;
    closed = true;
    if (resizeTimer !== null) {
      window.clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    // Drop the embedded panel observer so it cannot fire on a detached surface
    // after the preview is gone, and cancel a re-fit that was scheduled just
    // before the close. The frame callback also checks `closed`, but cancelling
    // frees the frame and keeps the teardown here complete, exactly like the
    // resizeTimer above.
    if (surfaceObserver !== null) {
      surfaceObserver.disconnect();
      surfaceObserver = null;
    }
    if (fitFrame !== null) {
      window.cancelAnimationFrame(fitFrame);
      fitFrame = null;
    }
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize);
    overlay.removeEventListener('mousedown', onOverlayMouseDown);
    closeBtn.removeEventListener('click', disposeAll);
    maxBtn.removeEventListener('click', onToggleMaximize);
    image.removeEventListener('load', onImageLoad);
    image.removeEventListener('error', onImageError);
    // Drag listeners live on window while a gesture is active, so they are
    // detached here too: closing mid-drag must not leave a handler pointing at
    // a removed dialog. Removing absent listeners is a no-op.
    resizeGrip.removeEventListener('mousedown', onGripMouseDown);
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    // An interrupted drag may still have text selection suppressed.
    document.body.style.userSelect = '';
    // The shared path box owns a document-level mousedown listener (leave search
    // mode on an outside click) and a debounce timer, so it is disposed with the
    // preview instead of being left attached to a removed element.
    pathBox.dispose();
    overlay.remove();
    // Tell the host only AFTER the DOM is gone, so a view-space tab is never
    // dropped while its preview is still half-disposed. A throwing callback
    // must not turn a completed close into an error, so it is contained here.
    if (options.onClose) {
      try {
        options.onClose();
      } catch (error) {
        console.error('[imageViewer] onClose handler failed', error);
      }
    }
  };

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    disposeAll();
  }

  function onOverlayMouseDown(e: MouseEvent): void {
    if (e.target === overlay) disposeAll();
  }

  // A decode failure leaves an empty frame, so explain it in the footer
  // instead of showing nothing at all.
  function onImageError(): void {
    failed = true;
    image.style.visibility = 'visible';
    setStatus('Unable to display this image', true);
  }

  function onImageLoad(): void {
    layout();
  }

  // Toggle between the image-sized dialog and the full work area. The icon
  // swaps to the opposite action so the button always describes what a click
  // will do next.
  function onToggleMaximize(): void {
    maximized = !maximized;
    // Drop the dragged size so each mode re-derives the window from the image
    // (maximized pins it to the work area via the stylesheet).
    userSized = false;
    if (maximized) {
      dialog.classList.add('maximized');
    } else {
      dialog.classList.remove('maximized');
    }

    maxBtn.textContent = '';
    maxBtn.appendChild(buildIcon(maximized ? ICON_RESTORE : ICON_MAXIMIZE));
    const label = maximized ? 'Restore size' : 'Maximize to screen';
    maxBtn.title = label;
    maxBtn.setAttribute('aria-label', label);
    maxBtn.setAttribute('aria-pressed', maximized ? 'true' : 'false');

    layout();
  }

  // Window resizes are coalesced: layout() reads the DOM, so running it on
  // every event of a drag would be wasteful.
  function onResize(): void {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      layout();
    }, 80);
  }

  // ---- Drag to resize ----
  // Mirrors makeResizable in src/rightWorkspace.ts: the gesture runs on
  // window-level mousemove/mouseup so it survives the pointer leaving the
  // 16px grip, only the primary button starts it, and text selection is
  // suppressed for the duration. The size is clamped to the same minimums
  // layout() uses and to the work area (window minus DIALOG_MARGIN).
  function onGripMouseDown(e: MouseEvent): void {
    if (closed || e.button !== 0) return;
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
    dialog.style.width = Math.round(width) + 'px';
    dialog.style.height = Math.round(height) + 'px';
    // From now on the dragged size wins over the image-derived one.
    userSized = true;
    // Re-fit the picture into the new box as the drag proceeds.
    layout();
  }

  function onDragEnd(): void {
    if (closed) return;
    document.body.style.userSelect = '';
    dialog.classList.remove('resizing');
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
  }

  // ---- Wiring ----
  maxBtn.appendChild(buildIcon(ICON_MAXIMIZE));
  maxBtn.title = 'Maximize to screen';
  maxBtn.setAttribute('aria-label', 'Maximize to screen');
  maxBtn.setAttribute('aria-pressed', 'false');

  closeBtn.addEventListener('click', disposeAll);
  image.addEventListener('load', onImageLoad);
  image.addEventListener('error', onImageError);
  // A window resize changes the space available even in embedded mode, and
  // onResize coalesces into a cheap re-fit, so this listener serves both.
  window.addEventListener('resize', onResize);

  // Dialog-only wiring: there is no backdrop to click, no grip to drag, no
  // maximize toggle and no Escape-to-close for an embedded preview, and the
  // close button must not steal focus from the surrounding panel.
  if (!embedded) {
    maxBtn.addEventListener('click', onToggleMaximize);
    overlay.addEventListener('mousedown', onOverlayMouseDown);
    resizeGrip.addEventListener('mousedown', onGripMouseDown);
    window.addEventListener('keydown', onKeyDown, true);
    closeBtn.focus();
  }

  // An embedded preview is sized by its host panel: dragging the view-space
  // resizer changes the surface without firing a window resize, so the picture
  // must be re-fitted whenever the observed box changes.
  //
  // The re-fit is NOT run inside the notification callback. layout() resizes
  // the <img> that lives inside the observed surface, so writing to the DOM
  // during the batch can queue another notification for the same frame, which
  // the browser reports as 'ResizeObserver loop completed with undelivered
  // notifications' (webpack-dev-server then paints it as an error overlay over
  // the preview). Two guards make that impossible:
  //
  //   1. the callback only RECORDS the size and defers the work to the next
  //      animation frame, which also coalesces the burst of notifications a
  //      panel drag produces;
  //   2. an unchanged content box is ignored outright, so a pass that changes
  //      nothing cannot re-arm the observer.
  let surfaceObserver: ResizeObserver | null = null;
  let observedW = -1;
  let observedH = -1;
  let fitFrame: number | null = null;

  const scheduleFit = (): void => {
    if (closed || fitFrame !== null) return;
    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = null;
      if (closed) return;
      layout();
    });
  };

  if (embedded && typeof ResizeObserver !== 'undefined') {
    surfaceObserver = new ResizeObserver((entries) => {
      if (closed) return;
      // Read the size from the reported entry instead of measuring the DOM, so
      // the callback stays free of forced synchronous layout work.
      const rect = entries.length > 0 ? entries[entries.length - 1].contentRect : null;
      const width = rect ? Math.round(rect.width) : -1;
      const height = rect ? Math.round(rect.height) : -1;
      if (width === observedW && height === observedH) return;
      observedW = width;
      observedH = height;
      scheduleFit();
    });
    surfaceObserver.observe(surface);
  }

  // A data: URI usually decodes before this point, in which case the `load`
  // event already fired and layout() would never run — so size it now.
  if (image.complete && image.naturalWidth > 0) layout();

  return {
    el: overlay,
    close: disposeAll
  };
}

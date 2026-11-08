/**
 * imageViewer.ts - the modal image preview opened from the 'Files' tab.
 *
 * Shows a single image scaled to fit the dialog. It deliberately mirrors
 * fileEditor.ts: the same overlay + dialog skeleton, the same header (title +
 * × close button), the same full-path line, Escape / backdrop / close-button
 * dismissal, and an idempotent dispose that removes every listener it adds.
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
 * closes on Escape, the close button, or a click on the dimmed backdrop. The
 * image is centred and scaled to fit the available area without ever being
 * upscaled beyond its natural size, so a small icon stays small while a large
 * screenshot shrinks to fit.
 */
export function openImageViewer(options: ImageViewerOptions): ImageViewerHandle {
  const parent = options.parent || document.body;

  // ---- DOM skeleton (mirrors fileEditor.ts) ----
  const overlay = document.createElement('div');
  overlay.className = 'image-viewer-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'image-viewer';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

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
  closeBtn.title = 'Close (Esc)';

  header.appendChild(title);
  header.appendChild(closeBtn);

  const pathLine = document.createElement('div');
  pathLine.className = 'image-viewer-path';
  pathLine.textContent = options.filePath;
  pathLine.title = options.filePath;

  const surface = document.createElement('div');
  surface.className = 'image-viewer-surface';

  const image = document.createElement('img');
  image.className = 'image-viewer-img';
  image.alt = options.fileName;
  image.src = 'data:' + options.mimeType + ';base64,' + options.base64;

  surface.appendChild(image);

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

  dialog.appendChild(header);
  dialog.appendChild(pathLine);
  dialog.appendChild(surface);
  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  parent.appendChild(overlay);

  // ---- State ----
  let closed = false;

  const setStatus = (text: string, isError: boolean): void => {
    status.textContent = text;
    status.className = isError ? 'image-viewer-status error' : 'image-viewer-status';
  };

  // ---- Lifecycle ----
  const disposeAll = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    overlay.removeEventListener('mousedown', onOverlayMouseDown);
    closeBtn.removeEventListener('click', disposeAll);
    image.removeEventListener('error', onImageError);
    overlay.remove();
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
    setStatus('Unable to display this image', true);
  }

  // ---- Wiring ----
  closeBtn.addEventListener('click', disposeAll);
  overlay.addEventListener('mousedown', onOverlayMouseDown);
  image.addEventListener('error', onImageError);
  window.addEventListener('keydown', onKeyDown, true);

  closeBtn.focus();

  return {
    el: overlay,
    close: disposeAll
  };
}

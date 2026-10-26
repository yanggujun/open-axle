import './attachment.css';

/**
 * Pasted-image attachments for chat boxes.
 *
 * Everything attachment-related lives here so the renderer only has to create a
 * state (createAttachmentState), register it for a model (registerAttachment)
 * and feed clipboard paste events to handleImagePaste.
 *
 * Images pasted into a chat box are captured, converted to base64 and listed in
 * an 'Images' popover at the right end of the controls bar. NOTE: sending them
 * is NOT wired up yet - the base64 payloads are collected and exposed via
 * getPastedImages() / window.pastedImages so the send/IPC path can pick them up
 * in a later step.
 */

/**
 * Hard limit on the number of pasted images that can be attached to one chat
 * box. Mirrors the agent/model limit (MAX_ATTACHMENTS in src/core/model.ts) so
 * the UI rejects extras rather than silently dropping them later.
 */
export const MAX_ATTACHMENTS = 5;

/** One image pasted into a chat box, parsed and ready to be sent. */
export interface PastedImage {
  /** Display/file name, e.g. 'pasted-image-1.png'. */
  name: string;
  /** MIME type, e.g. 'image/png'. */
  mimeType: string;
  /** Size of the original blob in bytes. */
  size: number;
  /** Raw base64 payload (no `data:` prefix) for sending as bytes later. */
  base64: string;
  /** Full `data:` URL, used for the thumbnail preview. */
  dataUrl: string;
  /** Optional object URL, revoked when the attachment is removed. */
  objectUrl?: string;
}

/**
 * Pending image attachments for ONE model's chat box.
 * `items` holds the parsed images (base64 payloads included); `btn` is the
 * 'Images' control at the right end of the controls bar and `popup` is the
 * popover it toggles, which lists the pending images (one row per image).
 */
export interface AttachmentState {
  items: PastedImage[];
  /** The 'Images' button on the controls bar (disabled while nothing is pending). */
  btn: HTMLButtonElement;
  /** The popover listing the pending images (shown/hidden by `btn`). */
  popup: HTMLElement;
  /** The scrolling list inside the popover holding one row per image. */
  list: HTMLElement;
  /** The 'Clear all' button in the popover footer. */
  clearBtn: HTMLButtonElement;
}

// Pending pasted images per model name, so each tab keeps its own state.
const attachmentsByModel = new Map<string, AttachmentState>();

// The model whose tab is currently in focus. Maintained by the renderer via
// setActiveModelName() so getPastedImages()/clearPastedImages() can default to
// it without importing renderer state.
let activeModelName: string | null = null;

/** Tell the module which model's tab is in focus (call on every tab switch). */
export function setActiveModelName(name: string | null): void {
  activeModelName = name;
}

/** Human-readable byte size, e.g. '512 B', '12.3 KB', '1.4 MB'. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** File extension for a MIME type, used to build a sensible paste name. */
export function extensionForMime(mimeType: string): string {
  const type = (mimeType || '').toLowerCase();
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/svg+xml') return 'svg';
  const sub = type.split('/')[1] || '';
  const cleaned = sub.replace(/[^a-z0-9]/g, '');
  return cleaned || 'png';
}

/** Convert an ArrayBuffer to raw base64, chunked to avoid arg-length limits. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, Array.from(slice) as any);
  }
  return btoa(binary);
}

/** Read a Blob/File's bytes as raw base64 (no `data:` prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

/** Read a Blob/File as a full `data:` URL via FileReader. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read pasted image'));
    reader.readAsDataURL(blob);
  });
}

/** Release any object URL held by an attachment (never throws). */
export function revokeAttachment(img: PastedImage): void {
  if (img.objectUrl) {
    try {
      URL.revokeObjectURL(img.objectUrl);
    } catch {
      /* already revoked */
    }
    img.objectUrl = undefined;
  }
}

/** Parse one pasted File/Blob into a PastedImage (base64 + data URL). */
export async function fileToPastedImage(file: Blob, index: number): Promise<PastedImage> {
  const mimeType = file.type || 'image/png';
  const named = file as File;
  const name = (named.name && named.name.length > 0)
    ? named.name
    : `pasted-image-${index + 1}.${extensionForMime(mimeType)}`;
  const [base64, dataUrl] = await Promise.all([blobToBase64(file), blobToDataUrl(file)]);
  return { name, mimeType, size: file.size, base64, dataUrl };
}

/** Redraw a chat box's attachment UI from its current attachment list. */
export function renderAttachments(state: AttachmentState): void {
  if (!state || !state.list || !state.popup) return;
  state.list.innerHTML = '';

  for (const img of state.items) {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.title = img.name;

    const thumb = document.createElement('img');
    thumb.className = 'attachment-thumb';
    thumb.src = img.dataUrl;
    thumb.alt = img.name;

    const meta = document.createElement('div');
    meta.className = 'attachment-meta';

    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = img.name;

    const size = document.createElement('span');
    size.className = 'attachment-size';
    size.textContent = formatBytes(img.size);

    meta.appendChild(name);
    meta.appendChild(size);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.title = `Remove ${img.name}`;
    remove.addEventListener('click', () => removeAttachment(state, img));

    item.appendChild(thumb);
    item.appendChild(meta);
    item.appendChild(remove);
    state.list.appendChild(item);
  }

  // Gray out the 'Images' button while nothing is pending, and keep its
  // tooltip in sync with the number of attached images.
  const count = state.items.length;
  if (state.btn) {
    state.btn.disabled = count === 0;
    state.btn.title = count === 0
      ? 'No pasted attachments'
      : `${count} pasted image${count === 1 ? '' : 's'}`;
  }
  state.clearBtn.disabled = count === 0;

  // Close the popover ONLY when the list just became empty. Otherwise leave
  // its open/closed state alone so removing one image keeps the popover open
  // for the next removal.
  if (count === 0 && state.popup) {
    state.popup.classList.add('hidden');
  }
}

/** Remove ONE pending attachment and redraw the UI. */
export function removeAttachment(state: AttachmentState, img: PastedImage): void {
  if (!state) return;
  revokeAttachment(img);
  const idx = state.items.indexOf(img);
  if (idx >= 0) state.items.splice(idx, 1);
  renderAttachments(state);
}

/** Drop ALL pending attachments for a chat box. */
export function clearAttachments(state: AttachmentState): void {
  if (!state) return;
  for (const img of state.items) revokeAttachment(img);
  state.items.length = 0;
  renderAttachments(state);
}

/**
 * Show/hide a chat box's attachment popover.
 * Opening is refused while no image is pending (the 'Images' button is
 * disabled in that state anyway); closing is always allowed.
 */
export function toggleAttachmentPopup(state: AttachmentState): void {
  if (!state || !state.popup) return;
  const isHidden = state.popup.classList.contains('hidden');
  if (isHidden && state.items.length === 0) return;
  state.popup.classList.toggle('hidden');
}

/**
 * Shared helper: append image blobs to a chat box's attachment list, enforcing
 * the MAX_ATTACHMENTS hard limit. Used by both the paste handler and the
 * drag-and-drop handler so the limit is enforced in exactly one place.
 */
export async function addImageFiles(files: Blob[], state: AttachmentState): Promise<void> {
  if (!state || files.length === 0) return;
  // Enforce the hard UI limit: only the first MAX_ATTACHMENTS images are
  // accepted; any extras are ignored (with a single warning). The agent/model
  // layer applies the same cap, so nothing is silently lost downstream.
  let skipped = 0;
  for (const file of files) {
    if (state.items.length >= MAX_ATTACHMENTS) {
      skipped += 1;
      continue;
    }
    try {
      const img = await fileToPastedImage(file, state.items.length);
      state.items.push(img);
    } catch (err) {
      console.error('[axle] Failed to read image:', err);
    }
  }
  if (skipped > 0) {
    console.warn(`[axle] Attachment limit reached (max ${MAX_ATTACHMENTS}); ${skipped} extra image(s) were ignored.`);
  }
  renderAttachments(state);
}

/**
 * Capture images pasted into a chat box.
 *
 * The browser's default paste behavior is prevented ONLY when the clipboard
 * actually contains at least one image, so a normal TEXT paste still flows
 * into the textarea untouched.
 */
export async function handleImagePaste(ev: ClipboardEvent, state: AttachmentState): Promise<void> {
  if (!state) return;
  const data = ev.clipboardData;
  if (!data) return;

  const files: Blob[] = [];

  // Preferred path: clipboardData.items carries kind/type metadata.
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  // Fallback: clipboardData.files (some platforms only populate this).
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      if (file.type.startsWith('image/')) files.push(file);
    }
  }

  if (files.length === 0) return; // No image: let the normal text paste happen.

  ev.preventDefault();
  await addImageFiles(files, state);
}

/**
 * Capture images DRAGGED onto a chat box (drag-and-drop). The dropped images
 * are COPIED into the attachment list using the same pipeline as paste, so a
 * drag behaves exactly like a paste. preventDefault stops the browser from
 * navigating to the dropped file; when the drag carries no image the default
 * behavior is left untouched.
 */
export async function handleImageDrop(ev: DragEvent, state: AttachmentState): Promise<void> {
  if (!state) return;
  const data = ev.dataTransfer;
  if (!data) return;

  const files: Blob[] = [];
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith('image/')) files.push(file);
  }

  if (files.length === 0) return; // No image: allow default drop behavior.

  ev.preventDefault();
  await addImageFiles(files, state);
}

/** Pending pasted images for a model (defaults to the active one). */
export function getPastedImages(modelName?: string): PastedImage[] {
  const name = modelName ?? activeModelName ?? undefined;
  const state = name ? attachmentsByModel.get(name) : undefined;
  return state ? state.items.slice() : [];
}

/** Drop every pending pasted image for a model (defaults to the active one). */
export function clearPastedImages(modelName?: string): void {
  const name = modelName ?? activeModelName ?? undefined;
  const state = name ? attachmentsByModel.get(name) : undefined;
  if (state) clearAttachments(state);
}

/**
 * Build the 'Images' button + popover DOM (list + footer + 'Clear all') and
 * return the new state together with the two nodes to insert into the controls
 * bar. The caller appends `button` and `popup` and keeps `state`.
 */
export function createAttachmentState(): { state: AttachmentState; button: HTMLButtonElement; popup: HTMLElement } {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'attachment-btn';
  btn.textContent = 'Attachments';
  btn.title = 'No pasted attachments';
  btn.disabled = true;

  const popup = document.createElement('div');
  popup.className = 'attachment-popup hidden';

  const list = document.createElement('div');
  list.className = 'attachment-list';

  const footer = document.createElement('div');
  footer.className = 'attachment-popup-footer';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'attachment-clear';
  clearBtn.textContent = 'Clear all';
  clearBtn.title = 'Remove all pasted attachments';
  clearBtn.disabled = true;

  footer.appendChild(clearBtn);
  popup.appendChild(list);
  popup.appendChild(footer);

  const state: AttachmentState = { items: [], btn, popup, list, clearBtn };

  // stopPropagation keeps the module-level outside-click handler from
  // immediately re-closing the popover the button just opened.
  btn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    toggleAttachmentPopup(state);
  });
  clearBtn.addEventListener('click', () => clearAttachments(state));

  // Keep the module's default-model lookup for this tab in sync even before
  // the first explicit setActiveModelName() call.
  if (activeModelName && !attachmentsByModel.has(activeModelName)) {
    renderAttachments(state);
  }

  return { state, button: btn, popup };
}

/** Register a model's attachment state so the module can resolve it by name. */
export function registerAttachment(modelName: string, state: AttachmentState): void {
  if (!modelName) return;
  attachmentsByModel.set(modelName, state);
}

/** Forget a model's attachment state (its panel/DOM was destroyed). */
export function disposeAttachment(modelName: string): void {
  const state = attachmentsByModel.get(modelName);
  if (state) {
    // Release any object URLs before dropping the reference.
    for (const img of state.items) revokeAttachment(img);
    state.items.length = 0;
  }
  attachmentsByModel.delete(modelName);
}

/** Forget EVERY model's attachment state (all panels are being rebuilt). */
export function clearAllAttachments(): void {
  for (const modelName of Array.from(attachmentsByModel.keys())) {
    disposeAttachment(modelName);
  }
}

// Expose the pending attachments as `window.pastedImages` so a later send/IPC
// step can read the base64 payloads without importing this module.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'pastedImages', {
    configurable: true,
    get: () => getPastedImages(),
  });
}

// One shared outside-click listener dismisses any OPEN attachment popover when
// the click lands outside that popover and outside its own 'Images' button.
// (The button itself stopPropagates its click so opening is never undone.)
document.addEventListener('click', (ev: MouseEvent) => {
  const target = ev.target as Node | null;
  for (const state of attachmentsByModel.values()) {
    if (!state || !state.popup || !state.btn) continue;
    if (state.popup.classList.contains('hidden')) continue;
    if (state.popup.contains(target)) continue;
    if (state.btn.contains(target)) continue;
    state.popup.classList.add('hidden');
  }
});

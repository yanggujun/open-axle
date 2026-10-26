import 'highlight.js/styles/github.css'
import './styles.css';
import './workingDir.css';
import './attachment.css';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { openFolderChooser } from './workingDir';
import type { RemoteServer } from './workingDir';
import { WorkingDir } from './common/common';
import {
  registerRightTab,
  openRightTab,
  initRightWorkspace,
  handleRightWorkspaceResize,
  collapseRightWorkspace,
  type RightWorkspaceApi,
} from './rightWorkspace';
import { LOGS_TAB_ID, buildLogView } from './logView';
import { FILES_TAB_ID, buildFilesView, refreshFiles, setFilesModelName, setFilesChangeDirHandler, setFilesSetDirHandler, setFilesInsertToChatHandler } from './filesTab';
import {
  createAttachmentState,
  registerAttachment,
  disposeAttachment,
  clearAllAttachments,
  clearPastedImages,
  setActiveModelName,
  handleImagePaste,
  handleImageDrop,
  type AttachmentState,
  type PastedImage,
} from './attachment';

// The renderer runs sandboxed (contextIsolation: true, nodeIntegration: false).
// It must NOT import Node core modules (fs) or main-only Electron APIs.
// All heavy lifting lives in the MAIN process via the window.axle bridge.

/** Shape of a configured LLM model. Must match src/core/llm.ts. */
interface ModelConfig {
  name: string;
  url: string;
  key: string;
  model: string;
  skillsFolder: string;
  responses?: boolean;
  active?: boolean;
  workingDir?: string;
}

/** Broadcast payload forwarded from the main process (includes modelName). */
interface AxleBroadcast {
  message: string;
  format?: string;
  modelName?: string;
  /**
   * Optional sidecar payload carried by the main process (the conduit Protocol
   * `content`). For image/file results this holds a ready-to-embed `data:` URI
   * (e.g. `data:image/svg+xml;base64,...`) so the renderer can display the
   * image directly instead of guessing its media type.
   */
  content?: string;
}

declare global {
  interface Window {
    axle: {
      getModels(): Promise<ModelConfig[]>;
      getActiveModels(): Promise<ModelConfig[]>;
      addModel(model: ModelConfig): Promise<ModelConfig[]>;
      setModelActive(modelName: string, active: boolean): Promise<boolean>;
      talk(text: string, modelName?: string, attachments?: { format: string; content: string }[]): Promise<void>;
      saveImage(dataUrl: string, modelName?: string): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }>;
      switchAgent(modelName: string): Promise<boolean>;
      getSkills(modelName?: string): Promise<string>;
      reload(modelName?: string): Promise<void>;
      clear(modelName?: string): Promise<void>;
      cd(dir: string, modelName?: string): Promise<boolean>;
      stop(modelName?: string): Promise<boolean>;
      validateDir(dir: string): Promise<boolean>;
      getDefaultDir(): Promise<string>;
      listDir(dir: string): Promise<string[]>;
      listEntries(dir: string): Promise<{ name: string; type: 'file' | 'folder' }[]>;
      listRemoteDir(serverName: string, remotePath?: string): Promise<{ path: string; dirs: string[]; error: string }>;
      getRemoteServers(): Promise<RemoteServer[]>;
      getWorkingDir(modelName: string): Promise<string>;
      setWorkingDir(dir: string, modelName: string): Promise<boolean>;
      onBroadcast(cb: (data: AxleBroadcast) => void): () => void;
      getWorkingDirInfo(modelName: string): Promise<WorkingDir>;
    };
    /**
     * Images pasted into the active chat box, as base64 payloads ready to be
     * sent. Read-only view over the renderer's pending-attachment state; the
     * send/IPC wiring is intentionally left for a later step.
     */
    readonly pastedImages: PastedImage[];
  }
}

// ---- Static (shell) DOM element references ----
// Only the tab bar and the workspaces container are static now. Both model
// workspaces AND the add-LLM config panel are built dynamically at runtime.
const tabBar = document.getElementById('tab-bar') as HTMLElement;
const workspaces = document.getElementById('workspaces') as HTMLElement;

/**
 * All DOM elements that make up ONE model's isolated workspace panel.
 * Each model owns its own set of these; nothing is shared between tabs.
 */
interface Workspace {
  panel: HTMLElement;
  chatLog: HTMLElement;
  messageInput: HTMLTextAreaElement;
  dirLabel: HTMLElement;
  /**
   * True while this model's continuous task loop is running. While true the
   * Send button shows 'Stop' (light orange) and the Enter key is ignored.
   */
  isRunning: boolean;
  btnSend: HTMLButtonElement;
  /** Images pasted into this model's chat box, awaiting send. */
  attachments: AttachmentState;
}

// ---- UI state ----
let models: ModelConfig[] = [];
// Full list of ALL configured models (including inactive/closed ones). Used to
// build the reopen menu on the '+' Add tab.
let allModels: ModelConfig[] = [];
let currentModelName: string | null = null;

// Per-model workspace panels. Keyed by model name. Each panel keeps its own
// DOM (and therefore its own chat history), so no shared buffering is needed.
const workspaceMap = new Map<string, Workspace>();

// The single, temporary "add LLM" config panel (built on demand when the user
// clicks the '+' tab). Only one config tab may exist at a time.
let configPanel: HTMLElement | null = null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderMarkdown(text: string): string {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: function (str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return '<pre><code class="hljs language-'+ lang+ '">' +
                hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                '</code></pre>';
        } catch (__) {}
      }
      // fallback: escape
      return '<pre class="hljs"><code>' + escapeHtml(str) + '</code></pre>';
    }
  });

  // Wrap rendered tables in a horizontally scrollable container so that wide
  // tables (too large for the message width) show a horizontal scroll bar
  // instead of overflowing the layout.
  md.renderer.rules.table_open = () => '<div class="table-scroll" style="overflow-x:auto; max-width:100%;">\n<table style="border-collapse: collapse; border: 1px solid #d0d7de;">\n';
  md.renderer.rules.table_close = () => '</table>\n</div>\n';

  // Add a border (and padding) to every header and data cell so that each
  // table cell is visually separated by a border line.
  md.renderer.rules.th_open = () => '<th style="border: 1px solid #d0d7de; padding: 6px 13px;">';
  md.renderer.rules.td_open = () => '<td style="border: 1px solid #d0d7de; padding: 6px 13px;">';

  return md.render(text) as string;
}

function formatBody(text: string, format = ''): string {
  return renderMarkdown(text);
}

/**
 * Singleton full-screen overlay used to view a chat-log image at its ORIGINAL
 * size (no scaling constraints). It is created lazily on first use and reused
 * afterwards. Clicking anywhere on the overlay, or pressing Escape, dismisses
 * it.
 */
let imageOverlay: HTMLDivElement | null = null;

function showImageOverlay(src: string, alt = ''): void {
  if (!imageOverlay) {
    imageOverlay = document.createElement('div');
    imageOverlay.className = 'image-overlay hidden';

    const big = document.createElement('img');
    big.className = 'image-overlay-img';
    imageOverlay.appendChild(big);

    // Any click on the overlay dismisses it (the image itself included).
    imageOverlay.addEventListener('click', () => {
      imageOverlay?.classList.add('hidden');
    });

    // Escape also dismisses the overlay.
    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && imageOverlay) {
        imageOverlay.classList.add('hidden');
      }
    });

    document.body.appendChild(imageOverlay);
  }

  const big = imageOverlay.querySelector('.image-overlay-img') as HTMLImageElement;
  big.src = src;
  big.alt = alt;
  big.title = alt;
  imageOverlay.classList.remove('hidden');
}

function renderMessageInto(
  log: HTMLElement,
  type: string,
  text: string,
  format = '',
  images: { dataUrl: string; name?: string }[] = []
): void {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${type}${format === 'reasoning' ? ' reasoning' : ''}`;
  const time = new Date().toLocaleTimeString();

  msgDiv.innerHTML = `
    <div class="message-header">
      <span class="time">${time}</span>
    </div>
    <div class="message-divider"></div>
    <div class="message-body">${text ? formatBody(text, format) : ''}</div>
  `;
  log.appendChild(msgDiv);

  // Render any image attachments inline as a thumbnail gallery, so images
  // that were sent WITH the message are visible in the chat log alongside
  // (or instead of) the text.
  if (images.length > 0) {
    const body = msgDiv.querySelector('.message-body') as HTMLElement;
    const gallery = document.createElement('div');
    gallery.className = 'message-images';
    for (const img of images) {
      const thumb = document.createElement('img');
      thumb.className = 'message-image-thumb';
      thumb.src = img.dataUrl;
      thumb.alt = img.name ?? 'attachment';
      thumb.title = img.name ?? '';
      // Clicking a thumbnail enlarges it to its ORIGINAL size in the overlay.
      thumb.style.cursor = 'pointer';
      thumb.addEventListener('click', () => showImageOverlay(img.dataUrl, img.name ?? ''));
      gallery.appendChild(thumb);
    }
    body.appendChild(gallery);
  }

  // Handle long system messages (broadcast type) truncation.
  if (type === 'broadcast') {
    const body = msgDiv.querySelector('.message-body') as HTMLElement;
    const threshold = log.clientHeight * 0.75; // 3/4 of the chat window height
    // Force layout to get full natural height.
    const fullHeight = body.scrollHeight;
    if (fullHeight > threshold && threshold > 0) {
      // Collapse the body to the threshold.
      body.style.maxHeight = threshold + 'px';
      body.style.overflowY = 'hidden';

      const moreBtn = document.createElement('button');
      moreBtn.className = 'message-more-btn';
      moreBtn.textContent = 'more...';
      moreBtn.style.cssText = 'display:block; float:right; margin-top:4px; cursor:pointer; color:#1a73e8; background:none; border:none; padding:0; font:inherit; text-decoration:underline;';
      msgDiv.appendChild(moreBtn);

      let expanded = false;
      moreBtn.addEventListener('click', () => {
        expanded = !expanded;
        if (expanded) {
          body.style.maxHeight = '';
          body.style.overflowY = '';
          moreBtn.textContent = 'less';
        } else {
          body.style.maxHeight = threshold + 'px';
          body.style.overflowY = 'hidden';
          moreBtn.textContent = 'more';
        }
      });
    }
  }

  log.scrollTop = log.scrollHeight;
}

/**
 * Build an isolated workspace panel for a single model and wire up all of its
 * per-tab event handlers (bound to this model's name). Returns the Workspace.
 */
function buildWorkspace(model: ModelConfig): Workspace {
  const modelName = model.name;

  const panel = document.createElement('div');
  panel.className = 'chat-area workspace hidden';
  panel.dataset.model = modelName;

  // Controls (skills / reload / clear + cd control)
  const controls = document.createElement('div');
  controls.className = 'controls';

  const btnSkills = document.createElement('button');
  btnSkills.textContent = 'Get Skills';
  const btnReload = document.createElement('button');
  btnReload.textContent = 'Reload';
  const btnClear = document.createElement('button');
  btnClear.textContent = 'Clear';

  const cdControl = document.createElement('div');
  cdControl.className = 'cd-control';
  const dirLabel = document.createElement('span');
  dirLabel.className = 'current-dir';
  dirLabel.textContent = 'Loading...';

  // NOTE: the 'Change Dir' control now lives in the right-dock 'Files' tab
  // (its '...' button). It was removed from the workspace controls; the
  // dock tab invokes the handler registered via setFilesChangeDirHandler().
  // The current-directory display was removed from the controls bar. The
  // dirLabel element and the Workspace.dirLabel field are kept intact so other
  // references (ws.dirLabel.textContent = ...) still compile, but the label is
  // no longer appended/shown here.
  //
  // The standalone 'Stop' button was REMOVED from the controls bar. Stopping
  // the running task loop is now handled by the Send button, which turns into
  // 'Stop' (light orange) for the duration of the loop (see handleResponse).

  // NOTE: the 'Logs' button was removed from the controls bar. The Logs dock
  // tab can still be opened programmatically (openRightTab(LOGS_TAB_ID)), but
  // there is no longer a button for it on this bar.

  // NOTE: the 'Files' button was removed from the controls bar. The Files dock
  // tab can still be opened programmatically (openRightTab(FILES_TAB_ID)).

  controls.appendChild(btnSkills);
  controls.appendChild(btnReload);
  controls.appendChild(btnClear);
  controls.appendChild(cdControl);

  // Chat log
  const chatLog = document.createElement('div');
  chatLog.className = 'chat-log';
  panel.appendChild(chatLog);

  // Controls row sits directly ABOVE the input area (moved from the top).
  panel.appendChild(controls);

  // Input area (chat box)
  const inputArea = document.createElement('div');
  inputArea.className = 'input-area';

  // Pasted-image attachments: createAttachmentState() (src/attachment.ts) builds
  // the 'Images' button, pinned to the LEFT of the chat box. While nothing is
  // pending it stays grayed out; as soon as at least one image is attached it
  // takes the Send button's accent color. Clicking it toggles the popover that
  // lists every pending image (thumbnail + name + size + '×' remove), with a
  // 'Clear all' action in its footer.
  const attachment = createAttachmentState();
  inputArea.appendChild(attachment.button);

  const messageInput = document.createElement('textarea');
  messageInput.placeholder = 'Type a message...';
  messageInput.rows = 3;
  const btnSend = document.createElement('button');
  btnSend.textContent = 'Send';
  // Tag the Send button with a dedicated class. Its disabled appearance is
  // defined by the `.send-btn:disabled` rule in styles.css; because setting
  // the button's `disabled` property reflects to the `disabled` attribute,
  // that rule takes effect automatically whenever the button is toggled
  // (see handleResponse, which disables the button while the agent runs).
  btnSend.className = 'send-btn';
  inputArea.appendChild(messageInput);
  inputArea.appendChild(btnSend);
  // The popover is absolutely positioned against .input-area, so it floats
  // above the chat box without consuming layout space.
  inputArea.appendChild(attachment.popup);
  panel.appendChild(inputArea);

  // Pending images for this chat box (used by the paste handler below).
  const attachments = attachment.state;

  const ws: Workspace = { panel, chatLog, messageInput, dirLabel, isRunning: false, btnSend, attachments };

  // Track this panel's pending pasted images so getPastedImages() /
  // window.pastedImages can resolve them for the model in focus.
  registerAttachment(modelName, attachments);

  // ---- Per-tab event handlers (bound to THIS model name) ----
  const doSend = (): void => {
    const text = messageInput.value.trim();
    // Pending pasted images for this chat box. The wire format is a list of
    // { format, content(base64) } objects; only the first 5 are sent (the
    // agent enforces the same hard limit).
    const pending = attachments.items.slice(0, 5);
    const attachmentList = pending.map((img) => ({
      format: (img.mimeType.split('/')[1] || 'png'),
      content: img.base64,
    }));
    const attachmentsToSend = attachmentList.length > 0 ? attachmentList : undefined;

    // Allow sending when there is text OR at least one attached image.
    if (!text && !attachmentsToSend) return;

    // The user's outgoing content is SPLIT into separate chat messages rather
    // than a single bubble with an inline thumbnail gallery: the typed text
    // becomes ONE 'user' chat message, and each attached image becomes its
    // OWN separate image message. Every image is shown at its ORIGINAL size,
    // but is scaled down (aspect ratio preserved) only when it would exceed
    // the chat window. The dataUrl stays valid after the pending list is
    // cleared (clearPastedImages only revokes the optional object URLs, not
    // the data: URLs).
    const imagesToShow = pending.map((img) => ({ dataUrl: img.dataUrl, name: img.name }));

    // 1) Chat text message -- rendered only when there is actual text.
    if (text) {
      renderMessageInto(chatLog, 'user', text, '');
    }

    // 2) One separate image message per attached image.
    for (const img of imagesToShow) {
      const imgMsg = document.createElement('div');
      imgMsg.className = 'message user image-message';
      const imgTime = new Date().toLocaleTimeString();
      imgMsg.innerHTML = `
        <div class="message-header">
          <span class="time">${imgTime}</span>
        </div>
        <div class="message-divider"></div>
        <div class="message-body"></div>
      `;

      const imgBody = imgMsg.querySelector('.message-body') as HTMLElement;
      const bigImg = document.createElement('img');
      bigImg.className = 'chat-image';
      bigImg.src = img.dataUrl;
      bigImg.alt = img.name || 'attachment';
      bigImg.title = img.name || 'Click to enlarge';
      bigImg.style.cursor = 'pointer';
      // Clicking the image enlarges it to its TRUE original size in the
      // full-screen overlay (which is not constrained by the chat window).
      bigImg.addEventListener('click', () => showImageOverlay(img.dataUrl, img.name || ''));
      imgBody.appendChild(bigImg);

      chatLog.appendChild(imgMsg);

      // Original size unless it exceeds the chat window: cap the width to the
      // message width and the height to the visible chat-log height. Because
      // both are MAX constraints, the browser scales the image down while
      // preserving its aspect ratio when either limit is exceeded; a smaller
      // image keeps its natural size untouched.
      bigImg.style.maxWidth = '100%';
      bigImg.style.height = 'auto';
      bigImg.style.maxHeight = Math.max(0, chatLog.clientHeight) + 'px';
    }

    chatLog.scrollTop = chatLog.scrollHeight;
    messageInput.value = '';
    window.axle.talk(text, modelName, attachmentsToSend);

    // Clear this model's pending images now that they have been sent (this
    // also refreshes the 'Attachments' button/popover via renderAttachments).
    if (attachmentsToSend) {
      clearPastedImages(modelName);
    }
  };

  // Send button. While this model's task loop is running the button doubles
  // as the Stop button (its text is 'Stop', see handleResponse) and a click
  // requests a stop; otherwise it sends the message. The Enter key below is
  // intentionally ignored while running: stopping is MOUSE-ONLY.
  btnSend.addEventListener('click', () => {
    if (ws.isRunning) {
      window.axle.stop(modelName);
      return;
    }
    doSend();
  });
  messageInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // While a task loop is running, Enter does NOTHING: stopping is
      // mouse-only (via the Send/Stop button). This prevents accidentally
      // sending/stopping mid-task from the keyboard.
      if (ws.isRunning) return;
      doSend();
    }
  });

  // Capture images pasted into this chat box. Text paste is deliberately
  // left untouched: handleImagePaste only preventDefaults when the clipboard
  // actually holds at least one image.
  messageInput.addEventListener('paste', (e: ClipboardEvent) => {
    void handleImagePaste(e, attachments);
  });

  // Capture images DRAGGED into the chat-box area. Dropped images are COPIED
  // into the attachment list (same pipeline as paste). Only image drags are
  // intercepted; text/other drags keep their default behavior.
  const dragHasImage = (e: DragEvent): boolean => {
    const dt = e.dataTransfer;
    if (!dt) return false;
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind === 'file' && item.type.startsWith('image/')) return true;
    }
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith('image/')) return true;
    }
    return false;
  };
  inputArea.addEventListener('dragover', (e: DragEvent) => {
    if (!dragHasImage(e)) return; // Let non-image drags behave normally.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  inputArea.addEventListener('drop', (e: DragEvent) => {
    void handleImageDrop(e, attachments);
  });

  btnSkills.addEventListener('click', () => {
    window.axle.getSkills(modelName);
  });

  btnReload.addEventListener('click', () => {
    window.axle.reload(modelName);
  });

  btnClear.addEventListener('click', () => {
    chatLog.innerHTML = '';
    window.axle.clear(modelName);
  });

  // The 'Change Dir' flow was moved to the right-dock 'Files' tab; its
  // handler is registered in setupRightWorkspace() via
  // setFilesChangeDirHandler(), which opens the folder chooser and applies
  // the chosen directory to the ACTIVE model (see changeActiveDir below).

  // On startup, load and display the persisted working directory.
  window.axle.getWorkingDir(modelName).then(dir => {
    dirLabel.textContent = dir || '';
  }).catch(() => {
    dirLabel.textContent = '';
  });

  return ws;
}

/**
 * Destroy and rebuild all MODEL workspace panels from the current `models`
 * list. If a config panel is currently open it is preserved and re-appended so
 * the add-LLM tab is not lost while rebuilding.
 */
function buildAllWorkspaces(): void {
  workspaces.innerHTML = '';
  workspaceMap.clear();
  // The panels (and therefore their attachment buttons/popovers) are being
  // destroyed. Drop the per-model attachment registry so no stale state
  // survives (this also revokes any pending object URLs).
  clearAllAttachments();

  for (const model of models) {
    const ws = buildWorkspace(model);
    workspaceMap.set(model.name, ws);
    workspaces.appendChild(ws.panel);
  }

  // Preserve an open config panel across a rebuild.
  if (configPanel) {
    workspaces.appendChild(configPanel);
  }
}

/** Route a broadcast to the matching model's OWN chat-log. */
function handleResponse(data: AxleBroadcast): void {
  const modelName = data.modelName ?? currentModelName ?? undefined;
  if (!modelName) return;

  const ws = workspaceMap.get(modelName);
  if (!ws) return; // Unknown model: ignore gracefully.

  // Control signal: the agent tells us whether its continuous task loop is
  // running. This does NOT belong in the chat log; it only toggles the Stop
  // button (enabled while running, disabled while idle).
  if (data.format === 'stop-state') {
    // While the conduit reports 'running' the Send button doubles as the
    // Stop button: its label becomes 'Stop' and it is tinted light orange.
    // When the conduit reports 'idle' it reverts to 'Send' with its normal
    // color. The button is NEVER disabled -- it must stay clickable so the
    // running task loop can be stopped with the mouse.
    const running = data.message === 'running';
    ws.isRunning = running;
    ws.btnSend.textContent = running ? 'Stop' : 'Send';
    ws.btnSend.classList.toggle('stop-mode', running);
    ws.btnSend.title = running ? 'Stop the running task loop' : 'Send the message';
    return;
  }

  renderMessageInto(ws.chatLog, 'broadcast', data.message, data.format);

  // Resolve an image source for this broadcast. Two cases can produce an
  // image:
  //   1) the model/responses flow, which sends format='image' with the base64
  //      payload (or a ready data: URL) in `message`;
  //   2) a file-read flow, which forwards a ready-to-embed `data:image/...`
  //      URI in the sidecar `content` slot -- this covers raster images AND
  //      SVG (read as text but embeddable as an image).
  let imageSrc: string | null = null;
  if (data.format === 'image' || data.format === 'svg') {
    imageSrc = data.content ?? null;
  }

  // Render the image as a chat message bubble IDENTICAL to a user-sent image:
  // the same .message bubble (header/time/divider/body), the same .chat-image
  // scaled to the chat window, and click-to-enlarge via the overlay. A Save
  // button is overlaid on the image (hover-revealed) so the image can still be
  // written into the working directory.
  if (imageSrc) {
    const src: string = imageSrc;

    const imgMsg = document.createElement('div');
    imgMsg.className = 'message broadcast image-message';
    const imgTime = new Date().toLocaleTimeString();
    imgMsg.innerHTML = `
      <div class="message-header">
        <span class="time">${imgTime}</span>
      </div>
      <div class="message-divider"></div>
      <div class="message-body"></div>
    `;

    const imgBody = imgMsg.querySelector('.message-body') as HTMLElement;

    // Wrap the image so the Save button can be absolutely positioned over it.
    const wrap = document.createElement('div');
    wrap.className = 'chat-image-wrap';

    const img = document.createElement('img');
    img.className = 'chat-image';
    img.src = src;
    img.alt = 'image';
    img.title = 'Click to enlarge';
    img.style.cursor = 'pointer';
    // Clicking the IMAGE enlarges it (the Save button stops propagation).
    img.addEventListener('click', () => showImageOverlay(src, ''));

    const saveBtn = document.createElement('button');
    saveBtn.className = 'chat-image-save';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.title = 'Save this image into the working directory';
    // Do not let the Save click bubble up to the image (which would enlarge).
    saveBtn.addEventListener('click', async (ev: MouseEvent) => {
      ev.stopPropagation();
      try {
        const res = await window.axle.saveImage(src, modelName);
        if (res && res.ok) {
          console.log('[axle] Image saved:', res.path);
          saveBtn.textContent = 'Saved';
        } else {
          console.warn('[axle] Save image failed:', res?.error);
          saveBtn.textContent = 'Failed';
        }
      } catch (e) {
        console.error('[axle] Save image error:', e);
        saveBtn.textContent = 'Failed';
      }
      // Restore the label after a moment.
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
    });

    wrap.appendChild(img);
    wrap.appendChild(saveBtn);
    imgBody.appendChild(wrap);

    ws.chatLog.appendChild(imgMsg);

    // Match the user-image sizing: show at ORIGINAL size but cap the width to
    // the message width and the height to the visible chat-log height. These
    // inline styles override the scoped `.chat-image-wrap .chat-image` 320px
    // clamp so the conduit image scales exactly like a user-sent image.
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.maxHeight = Math.max(0, ws.chatLog.clientHeight) + 'px';

    ws.chatLog.scrollTop = ws.chatLog.scrollHeight;
  }

}

/**
 * Build a form group (label + input) and return { group, input }.
 */
function makeField(labelText: string, type: string, placeholder: string): { group: HTMLElement; input: HTMLInputElement } {
  const group = document.createElement('div');
  group.className = 'form-group';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.placeholder = placeholder;
  group.appendChild(label);
  group.appendChild(input);
  return { group, input };
}

/**
 * Dynamically create the "add LLM" config panel (a workspace-style tab panel)
 * with its own form. On submit it persists the new model and swaps the config
 * tab for the newly-created model's workspace.
 */
function buildConfigPanel(): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'config-page workspace hidden';
  panel.dataset.config = 'true';

  const heading = document.createElement('h2');
  heading.textContent = 'Add an LLM Configuration';
  panel.appendChild(heading);

  const form = document.createElement('form');
  form.className = 'config-form';

  const nameField = makeField('Name', 'text', 'e.g. my-llm');
  const modelField = makeField('Model', 'text', 'model-name-here');
  const urlField = makeField('Base URL', 'text', 'https://api.example.com/v1');
  const keyField = makeField('API Key', 'password', 'sk-...');
  const skillsField = makeField('Skills folder', 'text', 'skills');

  // Responses API checkbox
  const respGroup = document.createElement('div');
  respGroup.className = 'form-group checkbox-group';
  const respLabel = document.createElement('label');
  const respInput = document.createElement('input');
  respInput.type = 'checkbox';
  respLabel.appendChild(respInput);
  respLabel.appendChild(document.createTextNode(' Use Responses API'));
  respGroup.appendChild(respLabel);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Add LLM';

  // Actions row: submit + (optional) cancel.
  const actions = document.createElement('div');
  actions.className = 'config-actions';
  actions.appendChild(submitBtn);

  // Only offer Cancel when there is at least one model to return to.
  if (models.length > 0) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'config-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => closeConfigView());
    actions.appendChild(cancelBtn);
  }

  form.appendChild(nameField.group);
  form.appendChild(modelField.group);
  form.appendChild(urlField.group);
  form.appendChild(keyField.group);
  form.appendChild(skillsField.group);
  form.appendChild(respGroup);
  form.appendChild(actions);
  panel.appendChild(form);

  form.addEventListener('submit', async (e: Event) => {
    e.preventDefault();

    const name = nameField.input.value.trim();
    const model = modelField.input.value.trim();
    const url = urlField.input.value.trim();
    const key = keyField.input.value.trim();
    const skillsFolder = skillsField.input.value.trim();
    const responses = respInput.checked;

    if (!name || !url || !key || !model) {
      console.warn('All fields (Name, Model, Base URL, API Key) are required to add an LLM.');
      return;
    }

    const newModel: ModelConfig = {
      name,
      url,
      key,
      model,
      skillsFolder: skillsFolder || 'skills',
      responses,
    };

    try {
      await window.axle.addModel(newModel);
      models = await window.axle.getActiveModels();
      allModels = await window.axle.getModels();
      closeConfigTab();
      buildAllWorkspaces();
      renderTabs();
      switchToModel(name);
    } catch (err) {
      console.error('Failed to add the LLM:', err);
    }
  });

  return panel;
}

/** Open (or re-focus) the single add-LLM config tab. */
function openConfigTab(): void {
  if (!configPanel) {
    configPanel = buildConfigPanel();
    workspaces.appendChild(configPanel);
  }

  // Hide all model panels; show only the config panel.
  for (const [, ws] of workspaceMap) {
    ws.panel.classList.add('hidden');
  }
  configPanel.classList.remove('hidden');
  currentModelName = null;

  // Make sure the tab bar reflects the open config tab.
  showWorkspaces();
  renderTabs();
}

/** Close and destroy the config tab if present. */
function closeConfigTab(): void {
  if (configPanel) {
    configPanel.remove();
    configPanel = null;
  }
}

/**
 * Close the 'New LLM' config view and return to a model workspace. If at least
 * one model exists we switch to the first; otherwise we simply show the (empty)
 * workspaces shell. Used by the config tab's close (×) and the form's Cancel.
 */
function closeConfigView(): void {
  closeConfigTab();
  renderTabs();
  if (models.length > 0) {
    switchToModel(models[0].name);
  } else {
    showWorkspaces();
  }
}

// ---- Tab rendering ----
function renderTabs(): void {
  tabBar.innerHTML = '';

  const configOpen = configPanel !== null;

  for (const model of models) {
    const isActive = !configOpen && model.name === currentModelName;
    const tab = document.createElement('div');
    tab.className = 'tab-button' + (isActive ? ' active' : '');
    tab.dataset.model = model.name;

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = model.name;
    label.addEventListener('click', () => switchToModel(model.name));
    tab.appendChild(label);

    // Close (×) icon: deactivates the model and removes its tab/workspace.
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      closeModel(model.name);
    });
    tab.appendChild(close);

    tabBar.appendChild(tab);
  }

  // '+' Add tab: opens the dynamic config tab.
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-button add-tab';
  addBtn.id = 'add-tab-btn';
  addBtn.textContent = '+ Add';
  addBtn.addEventListener('click', openAddMenu);
  tabBar.appendChild(addBtn);

  // Temporary 'New LLM' tab shown only while the config tab is open.
  if (configOpen) {
    const cfgTab = document.createElement('div');
    cfgTab.className = 'tab-button config-tab active';

    const cfgLabel = document.createElement('span');
    cfgLabel.className = 'tab-label';
    cfgLabel.textContent = 'New LLM';
    cfgLabel.addEventListener('click', openConfigTab);
    cfgTab.appendChild(cfgLabel);

    // Close (×) icon: dismiss the config view and return to a model workspace.
    const cfgClose = document.createElement('span');
    cfgClose.className = 'tab-close';
    cfgClose.textContent = '×';
    cfgClose.title = 'Close';
    cfgClose.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      closeConfigView();
    });
    cfgTab.appendChild(cfgClose);

    tabBar.appendChild(cfgTab);
  }
}

function showWorkspaces(): void {
  tabBar.classList.remove('hidden');
  workspaces.classList.remove('hidden');
  // Ensure the right-side dock is initialized (idempotent) as soon as the
  // workspaces shell is shown, so its tabs and resize grip are ready to use.
  initRightWorkspace();
}

/** Show only the active model's workspace panel; hide the rest (and config). */
function switchToModel(modelName: string): void {
  currentModelName = modelName;
  // Let the attachment module know which tab is in focus so getPastedImages() /
  // window.pastedImages default to THIS model's pending images.
  setActiveModelName(modelName);
  window.axle.switchAgent(modelName);

  // Point the right-dock 'Files' tab at this model so it shows the working
  // directory of the model currently in focus.
  setFilesModelName(modelName);

  // Hide the config panel (if any) when switching to a model.
  if (configPanel) {
    configPanel.classList.add('hidden');
  }

  // Toggle visibility so only the active model's panel is shown.
  for (const [name, ws] of workspaceMap) {
    ws.panel.classList.toggle('hidden', name !== modelName);
  }

  // Update tab active state.
  const tabs = tabBar.querySelectorAll('.tab-button');
  tabs.forEach((tab) => {
    const el = tab as HTMLElement;
    el.classList.toggle('active', el.dataset.model === modelName);
  });

}

/** Close a model tab: deactivate it, remove its workspace, switch elsewhere. */
async function closeModel(name: string): Promise<void> {
  try {
    await window.axle.setModelActive(name, false);
  } catch (e) {
    console.error('Failed to close model:', e);
  }

  models = models.filter(m => m.name !== name);

  const ws = workspaceMap.get(name);
  if (ws) {
    ws.panel.remove();
    workspaceMap.delete(name);
    // Forget this model's pending pasted images together with its panel so
    // no state outlives the destroyed attachment button/popover (this also
    // revokes any pending object URLs).
    disposeAttachment(name);
  }

  if (currentModelName === name) {
    currentModelName = null;
  }

  renderTabs();

  if (models.length > 0) {
    switchToModel(models[0].name);
  } else {
    openConfigTab();
  }
}

/** Reopen a previously-closed model: reactivate it and switch to it. */
async function reopenModel(name: string): Promise<void> {
  try {
    await window.axle.setModelActive(name, true);
    models = await window.axle.getActiveModels();
    allModels = await window.axle.getModels();
  } catch (e) {
    console.error('Failed to reopen model:', e);
    return;
  }
  closeConfigTab();
  buildAllWorkspaces();
  renderTabs();
  switchToModel(name);
}

/** Remove any add-menu dropdown. */
function closeAddMenu(): void {
  const existing = document.getElementById('add-menu');
  if (existing) {
    existing.remove();
  }
}

/**
 * Click handler for the '+' Add tab. If there are inactive (closed) models,
 * show a small dropdown letting the user reopen one or create a brand new LLM.
 * If there are none, open the config tab directly.
 */
async function openAddMenu(): Promise<void> {
  // Refresh the full list so the menu reflects the latest closed models.
  try {
    allModels = await window.axle.getModels();
  } catch (e) {
    console.error('Failed to load all models:', e);
  }

  const inactive = allModels.filter(m => !models.some(a => a.name === m.name));

  if (inactive.length === 0) {
    openConfigTab();
    return;
  }

  // Toggle: if a menu is already open, close it.
  if (document.getElementById('add-menu')) {
    closeAddMenu();
    return;
  }

  const menu = document.createElement('div');
  menu.id = 'add-menu';
  menu.className = 'add-menu';

  for (const m of inactive) {
    const item = document.createElement('button');
    item.className = 'add-menu-item';
    item.textContent = m.name;
    item.addEventListener('click', () => {
      closeAddMenu();
      reopenModel(m.name);
    });
    menu.appendChild(item);
  }

  // Divider between the reopen list and the 'create new' action.
  const divider = document.createElement('div');
  divider.className = 'add-menu-divider';
  menu.appendChild(divider);

  const newItem = document.createElement('button');
  newItem.className = 'add-menu-item add-menu-new';
  newItem.textContent = '+ New LLM';
  newItem.addEventListener('click', () => {
    closeAddMenu();
    openConfigTab();
  });
  menu.appendChild(newItem);

  // Attach to <body> and float it (position: fixed) directly under the '+ Add'
  // button using viewport coordinates, so the tab bar's overflow can't clip it.
  document.body.appendChild(menu);
  const addBtnEl = document.getElementById('add-tab-btn');
  if (addBtnEl) {
    const r = addBtnEl.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 2) + 'px';
  }

  // Close the menu when clicking anywhere else.
  setTimeout(() => {
    const onDocClick = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        closeAddMenu();
        document.removeEventListener('click', onDocClick);
      }
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

// ---- Right-side dock (pluggable workspace tabs) ----

/**
 * Register the built-in right-dock tab types and open them. The dock is
 * PLUGGABLE: additional tab types can be added later by calling
 * registerRightTab() (or via window.rightWorkspace.registerTab). The first two
 * built-in tabs are:
 *   - 'Logs'  -> the live application log (src/logView.ts)
 *   - 'Files' -> the working directory's sub-folders and files (src/filesTab.ts)
 */
/**
 * Open the folder chooser and apply the chosen directory to the ACTIVE model,
 * then refresh the Files tab so its listing reflects the new directory. This
 * is the handler invoked by the Files tab's '...' (Change Dir) button; it is
 * registered via setFilesChangeDirHandler in setupRightWorkspace().
 */
async function changeActiveDir(): Promise<void> {
  const modelName = currentModelName;
  if (!modelName) {
    console.warn('Change Dir: no active model.');
    return;
  }

  const chosenDir = await openFolderChooser(modelName);
  console.log(`Selecting ${chosenDir}`);
  if (!chosenDir) return;

  await window.axle.setWorkingDir(chosenDir, modelName);
  await window.axle.cd(chosenDir, modelName);

  // Reflect the new directory in the ACTIVE model's workspace dir label.
  const ws = workspaceMap.get(modelName);
  if (ws) ws.dirLabel.textContent = chosenDir;

  // Reload the Files tab so the listing reflects the new working directory.
  refreshFiles();
}

/**
 * Verify a user-typed directory and, only when valid, apply it to the ACTIVE
 * model (setWorkingDir + cd), update that model's workspace dir label and
 * refresh the Files tab. Returns true on success, false when the path is
 * invalid / no model is active, so the Files tab's editable path box can revert
 * the typed value. Registered via setFilesSetDirHandler in setupRightWorkspace().
 */
async function applyTypedDir(path: string): Promise<boolean> {
  const modelName = currentModelName;
  if (!modelName) {
    console.warn('Change Dir: no active model.');
    return false;
  }

  const dir = path.trim();
  if (!dir) return false;

  // 1) Verify the typed path BEFORE changing anything.
  let valid = false;
  try {
    valid = await window.axle.validateDir(dir);
  } catch (e) {
    console.error('validateDir failed:', e);
    valid = false;
  }
  if (!valid) {
    console.warn('Change Dir: invalid directory:', dir);
    return false;
  }

  // 2) Apply the verified path to the active model.
  await window.axle.setWorkingDir(dir, modelName);
  await window.axle.cd(dir, modelName);

  // Reflect the new directory in the ACTIVE model's workspace dir label.
  const ws = workspaceMap.get(modelName);
  if (ws) ws.dirLabel.textContent = dir;

  // Reload the Files tab so the listing reflects the new working directory.
  refreshFiles();

  return true;
}

function setupRightWorkspace(): void {
  // Register the change-dir handler invoked by the Files tab's '...' button.
  // It operates on the model currently in focus (currentModelName).
  setFilesChangeDirHandler(() => { void changeActiveDir(); });

  // Register the typed-path handler invoked by the Files tab's editable path
  // box; it verifies the typed directory and applies it to the active model.
  setFilesSetDirHandler((p: string) => applyTypedDir(p));

  // Register the 'insert into chat' handler invoked when a FILE row in the
  // Files tab is DOUBLE-CLICKED: append the file's name to the chat box of the
  // model currently in focus (inserting a separating space when it already has
  // text), then focus the box and move the caret to the end so typing can
  // continue seamlessly. No-op when no model is active.
  setFilesInsertToChatHandler((fileName: string) => {
    if (!fileName) return;
    const modelName = currentModelName;
    if (!modelName) return;
    const ws = workspaceMap.get(modelName);
    if (!ws) return;

    const input = ws.messageInput;
    const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
    input.value = input.value + sep + fileName;

    // Focus the chat box and place the caret at the end of the inserted text.
    input.focus();
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      /* setSelectionRange is unsupported for some input types; ignore. */
    }
  });

  // Register the built-in tab TYPES (idempotent: re-registering just replaces
  // the definition, so it is safe to call on every init).
  registerRightTab({
    id: LOGS_TAB_ID,
    title: 'Logs',
    icon: '\ud83d\udcdc',
    order: 10,
    mount: buildLogView,
  });
  registerRightTab({
    id: FILES_TAB_ID,
    title: 'Files',
    icon: '\ud83d\udcc1',
    order: 20,
    mount: buildFilesView,
  });

  // Initialize the dock controller (resolves its DOM elements and wires the
  // resize grip) -- idempotent, so calling it again in showWorkspaces is safe.
  initRightWorkspace();

  // Open both built-in tabs so they are ready in the dock. (openRightTab
  // expands the dock via setActive -> showDock; we collapse it right after so
  // the app starts minimized.)
  openRightTab(LOGS_TAB_ID);
  openRightTab(FILES_TAB_ID);

  // Start with the dock COLLAPSED (minimized) at the far right: only the
  // extend button is shown until the user clicks it to expand.
  collapseRightWorkspace();
}

// ---- Initialization ----
async function init(): Promise<void> {
  window.axle.onBroadcast((data: AxleBroadcast) => handleResponse(data));

  // Bring up the pluggable right-side dock (Logs + Files tabs).
  setupRightWorkspace();

  // Keep the right workspace at its current SHOW PERCENTAGE when the main
  // window is resized: recompute --right-width from the retained fraction.
  // Debounced via requestAnimationFrame so a burst of resize events only
  // triggers one re-layout per frame.
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      handleRightWorkspaceResize();
    });
  });

  // Fetch ACTIVE models (for tabs) and ALL models (for the reopen menu).
  try {
    models = await window.axle.getActiveModels();
  } catch (e) {
    console.error('error retrieving active models:', e);
    models = [];
  }
  try {
    allModels = await window.axle.getModels();
  } catch (e) {
    console.error('error retrieving all models:', e);
    allModels = [];
  }

  if (models.length === 0) {
    // No models configured: open the dynamic config tab automatically.
    showWorkspaces();
    openConfigTab();
  } else {
    // Build one isolated workspace per model, then activate the first one.
    buildAllWorkspaces();
    showWorkspaces();
    renderTabs();
    switchToModel(models[0].name);
  }
}

init();

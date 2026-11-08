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
import { FILES_TAB_ID, buildFilesView, refreshFiles, setFilesModelName, setFilesChangeDirHandler, setFilesSetDirHandler, setFilesInsertToChatHandler, getFilesHighlightedFolder } from './filesTab';
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

/**
 * Destination for a 'Save' action taken from the chat log or an image preview:
 * the folder currently HIGHLIGHTED in the Files tab, expressed the way the main
 * process parses paths.
 *
 * Returns undefined when nothing is highlighted (or a FILE is), which leaves the
 * save handlers using the agent's working directory exactly as before. The
 * `only` filter lets the image flow ask for a LOCAL folder, because saving an
 * image over SFTP is not supported: a remote highlight then simply falls back.
 */
function highlightedSaveTarget(only?: 'local' | 'remote'): string | undefined {
  const folder = getFilesHighlightedFolder();
  if (!folder) return undefined;
  if (only === 'local' && folder.remote) return undefined;
  if (only === 'remote' && !folder.remote) return undefined;
  // Remote folders must carry the ssh:// prefix the main parser expects.
  return folder.remote ? 'ssh://' + (folder.server || '') + folder.path : folder.path;
}

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
  /**
   * Conduit Protocol `signal`. 'persistable' messages offer hover buttons that
   * save them into the working directory or into its `.axle` folder.
   */
  signal?: string;
}

declare global {
  interface Window {
    axle: {
      getModels(): Promise<ModelConfig[]>;
      getActiveModels(): Promise<ModelConfig[]>;
      /** Create a new model and persist it to .llm.config. */
      addModel(model: ModelConfig): Promise<ModelConfig[]>;
      /**
       * Update an EXISTING model. The name is the immutable key: it selects the
       * entry and can never be changed, so only the remaining settings are
       * applied.
       */
      updateModel(modelName: string, patch: Partial<ModelConfig>): Promise<ModelConfig[]>;
      /**
       * List the models the given Base URL exposes (OpenAI-compatible
       * /v1/models), authenticated with the supplied API key.
       */
      listModels(baseUrl: string, apiKey: string): Promise<{ ok: boolean; models: string[]; error?: string }>;
      /** Toggle a model's active (open) flag. */
      setModelActive(modelName: string, active: boolean): Promise<boolean>;

      talk(text: string, modelName?: string, attachments?: { format: string; content: string }[]): Promise<void>;
      saveImage(dataUrl: string, modelName?: string, fileName?: string, targetDir?: string): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }>;
      savePromptFile(content: string, modelName?: string, fileName?: string, asSkill?: boolean, targetDir?: string): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }>;
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
  signal = '',
  modelName?: string
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

  // A 'persistable' message offers hover-revealed actions that save its text
  // into the working directory or into the working directory's .axle folder.
  if (signal && signal.toLowerCase() === 'persistable' && text) {
    attachPersistableActions(msgDiv, text, modelName);
  }

  log.scrollTop = log.scrollHeight;
}

/**
 * Attach the hover-revealed actions of a 'persistable' message.
 *
 * Two buttons are shown while the pointer is over the message:
 *   - 'Save'           writes the message text into the working directory;
 *   - 'Save as Skill'  writes it into <workingDir>/.axle (created if missing).
 *
 * Both open the SAME inline name editor the chat-log images use (file-name
 * input + confirm check mark + cancel X + error line), so choosing a name
 * behaves identically everywhere. As in the image Save flow, the editor is
 * shown IN PLACE of the buttons: it is inserted at the action bar's position
 * and absolutely positioned in the same top-right corner the 'Save' /
 * 'Save as Skill' buttons occupy (the buttons are hidden while it is open),
 * instead of being appended at the bottom of the message. Once opened it is
 * NOT hover-gated, so it stays visible while the user types. The actual write
 * happens in the MAIN process (axle:savePromptFile) because the renderer is
 * sandboxed; that handler supports BOTH local and remote (ssh://) working
 * directories.
 */
function attachPersistableActions(
  msgDiv: HTMLElement,
  content: string,
  modelName?: string
): void {
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const stamp = (d: Date): string =>
    '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  const defaultName = (): string => 'prompt-' + stamp(new Date()) + '.md';

  /**
   * Turn whatever the user typed into a plain file name: no directory part,
   * no characters that are illegal on Windows/POSIX, no leading dots, and a
   * '.md' extension when none was given. The main process sanitizes again.
   */
  const normalizeName = (raw: string): string => {
    let name = raw.split(/[\\/]/).pop() || '';
    name = name.replace(/[<>:"/\\|?*]/g, '');
    name = name.replace(/^\.+/, '').trim();
    if (!name) return defaultName();
    if (!/\.[a-zA-Z0-9]+$/.test(name)) name += '.md';
    return name;
  };

  let editor: HTMLElement | null = null;

  const closeEditor = (): void => {
    if (editor) {
      editor.remove();
      editor = null;
    }
    actions.style.display = '';
  };

  /**
   * Open the shared name editor. `asSkill` decides the destination folder:
   * the working directory itself, or its .axle sub-folder.
   */
  const openEditor = (asSkill: boolean): void => {
    if (editor) return;

    // The buttons are REPLACED by the editor while it is open.
    actions.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'chat-image-save-editor prompt-save-editor';
    // Clicks inside the editor must not bubble further up.
    panel.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'chat-image-save-name';
    nameInput.value = defaultName();
    nameInput.title = asSkill
      ? 'File name (saved into the .axle folder)'
      : 'File name (saved into the working directory)';

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'chat-image-save-confirm';
    confirmBtn.textContent = '\u2713';
    confirmBtn.title = 'Confirm the name and save (Enter)';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'chat-image-save-cancel';
    cancelBtn.textContent = '\u2715';
    cancelBtn.title = 'Cancel (Escape)';

    const errorLine = document.createElement('div');
    errorLine.className = 'chat-image-save-error';

    let saving = false;

    const doSave = async (): Promise<void> => {
      if (saving) return;

      const raw = nameInput.value.trim();
      if (!raw) {
        errorLine.textContent = 'Please enter a file name.';
        nameInput.focus();
        return;
      }
      const fileName = normalizeName(raw);

      saving = true;
      confirmBtn.disabled = true;
      errorLine.textContent = '';

      try {
        // A folder highlighted in the Files tab becomes the destination, so a
        // saved prompt (or skill) lands where the user pointed instead of always
        // in the agent's working directory. Both local and ssh:// folders are
        // supported by the handler; no highlight leaves the argument undefined.
        const saveTarget = highlightedSaveTarget();
        const res = await window.axle.savePromptFile(content, modelName, fileName, asSkill, saveTarget);
        if (!res || !res.ok) {
          console.warn('[axle] Save prompt file failed:', res && res.error);
          errorLine.textContent = (res && res.error) || ('Failed to save "' + fileName + '".');
          return;
        }
        console.log('[axle] Prompt file saved:', res.path);
        closeEditor();
      } catch (e) {
        console.error('[axle] Save prompt file error:', e);
        errorLine.textContent = 'Failed to save the file.';
      } finally {
        saving = false;
        confirmBtn.disabled = false;
      }
    };

    confirmBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      void doSave();
    });

    cancelBtn.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      closeEditor();
    });

    nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void doSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeEditor();
      }
    });

    const buttonRow = document.createElement('div');
    buttonRow.className = 'chat-image-save-actions';
    buttonRow.appendChild(confirmBtn);
    buttonRow.appendChild(cancelBtn);

    panel.appendChild(nameInput);
    panel.appendChild(buttonRow);
    panel.appendChild(errorLine);
    // Show the editor IN PLACE of the Save / 'Save as Skill' buttons: it is
    // absolutely positioned in the very top-right corner those buttons occupy
    // (see .chat-image-save-editor.prompt-save-editor in styles.css), exactly
    // like the chat-image editor replaces the image's Save button -- instead of
    // being appended at the bottom of the message. It is NOT hover-gated, so it
    // stays open and visible while the user types even when the pointer leaves
    // the message.
    msgDiv.insertBefore(panel, actions.nextSibling);
    editor = panel;

    nameInput.focus();
    try { nameInput.select(); } catch { /* ignore */ }
  };

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'message-action-btn';
  saveBtn.textContent = 'Save';
  saveBtn.title = 'Save this message into the working directory';
  saveBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    openEditor(false);
  });

  const skillBtn = document.createElement('button');
  skillBtn.type = 'button';
  skillBtn.className = 'message-action-btn';
  skillBtn.textContent = 'Save as Skill';
  skillBtn.title = 'Save this message into the .axle folder of the working directory';
  skillBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    openEditor(true);
  });

  actions.appendChild(saveBtn);
  actions.appendChild(skillBtn);
  msgDiv.appendChild(actions);
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

  // Resolve an image source FIRST for this broadcast. Two cases can produce
  // an image:
  //   1) the model/responses flow, which sends format='image' with the base64
  //      payload (or a ready data: URL) in `message`;
  //   2) a file-read flow, which forwards a ready-to-embed `data:image/...`
  //      URI in the sidecar `content` slot -- this covers raster images AND
  //      SVG (read as text but embeddable as an image).
  let imageSrc: string | null = null;
  if (data.format === 'image' || data.format === 'svg') {
    const sidecar = data.content ?? '';

    if (data.format === 'svg') {
      // For data.format === 'svg' the SVG source is carried in the sidecar
      // `content` (falling back to `message`). A payload that already is a
      // ready-to-embed data: URI is passed through untouched. Raw markup is
      // normalised and embedded as an <img>-compatible data: URI. A browser
      // refuses to rasterise an SVG served through <img> when the root <svg>
      // element lacks the SVG namespace, so we guarantee `xmlns` is present;
      // encodeURIComponent is REQUIRED because an unencoded '#' (fill/stroke
      // colours) would be read as a URL fragment and truncate the picture.
      const svgRaw = sidecar || data.message || '';
      if (svgRaw) {
        if (svgRaw.startsWith('data:')) {
          imageSrc = svgRaw;
        } else if (svgRaw.trim().startsWith('<')) {
          let svg = svgRaw.trim();
          const svgIdx = svg.toLowerCase().indexOf('<svg');
          if (svgIdx >= 0) {
            const end = svg.indexOf('>', svgIdx);
            const openTag = end >= 0 ? svg.slice(svgIdx, end) : svg.slice(svgIdx);
            if (!/xmlns/i.test(openTag)) {
              svg = svg.slice(0, svgIdx) + '<svg xmlns="http://www.w3.org/2000/svg"' + svg.slice(svgIdx + 4);
            }
          }
          imageSrc = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
        } else {
          imageSrc = 'data:image/svg+xml;base64,' + svgRaw.replace(/\s+/g, '');
        }
      }
    } else {
      // Raster image: `content` already holds the finished data: URI / base64.
      imageSrc = sidecar || null;
    }
  }

  // Text bubble. For data.format === 'svg' the picture rendered below IS the
  // message: never also dump the SVG source into the chat log, otherwise the
  // same content is shown twice (once as escaped source, once as the picture).
  // The escaped source is still shown when no picture could be built, so a
  // broken payload is never silently swallowed.
  if (data.message && !(data.format === 'svg' && imageSrc)) {
    renderMessageInto(ws.chatLog, 'broadcast', data.message, data.format, data.signal ?? '', modelName);
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

    // ---- Inline "save image" name editor -------------------------------
    // Helpers used by the Save editor below. They live in this block so they
    // travel with the image that owns them.

    /** Map the media type of an image data: URI to a file extension. */
    function imageExtFromSrc(dataUrl: string): string {
      const m = /^data:image\/([a-zA-Z0-9.+-]+)[;,]/.exec(dataUrl || '');
      const sub = (m ? m[1] : '').toLowerCase();
      if (sub === 'jpeg' || sub === 'jpg') return '.jpg';
      if (sub === 'svg+xml' || sub === 'svg') return '.svg';
      if (sub === 'png') return '.png';
      if (sub === 'gif') return '.gif';
      if (sub === 'webp') return '.webp';
      if (sub === 'bmp') return '.bmp';
      if (sub === 'x-icon' || sub === 'vnd.microsoft.icon') return '.ico';
      if (sub === 'tiff') return '.tiff';
      if (sub === 'avif') return '.avif';
      return '.png';
    }

    /** 'YYYYMMDD-HHMMSS' timestamp used in the default image file name. */
    function timestampForFileName(d: Date): string {
      const p = (n: number): string => String(n).padStart(2, '0');
      return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
        '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    /** Pre-filled name shown in the editor: image-<timestamp>.<ext> */
    function defaultImageFileName(dataUrl: string): string {
      return 'image-' + timestampForFileName(new Date()) + imageExtFromSrc(dataUrl);
    }

    /**
     * Turn whatever the user typed into a plain file name for the working
     * directory: no directory part, no characters that are illegal on
     * Windows/POSIX file systems, no leading dots, and always carrying an
     * image extension.
     */
    function normalizeImageFileName(raw: string, dataUrl: string): string {
      let name = raw.replace(/^.*[\\/]/, '');
      name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '');
      name = name.replace(/^\.+/, '').trim();
      if (!name) name = defaultImageFileName(dataUrl);
      if (!/\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i.test(name)) {
        name += imageExtFromSrc(dataUrl);
      }
      return name;
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'chat-image-save';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.title = 'Save this image into the working directory';

    /**
     * Replace the Save button with an inline editor: a file-name input with a
     * confirm button immediately to its RIGHT and an error line underneath.
     * Pressing Enter in the input or clicking the confirm button saves the
     * image into the model's working directory; Escape cancels. If a file with
     * the same name already exists there the save FAILS (nothing is
     * overwritten) and the editor stays open showing the conflict.
     */
    const openSaveEditor = (): void => {
      // Never open a second editor on the same image.
      if (wrap.querySelector('.chat-image-save-editor')) return;

      // The Save button is REPLACED by the editor while it is open.
      saveBtn.style.display = 'none';

      const editor = document.createElement('div');
      editor.className = 'chat-image-save-editor';
      editor.style.cssText = 'display:flex; align-items:center; gap:4px; flex-wrap:wrap;';
      // Clicks inside the editor must never reach the image (which would open
      // the full-screen overlay and swallow the interaction).
      editor.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); });

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'chat-image-save-name';
      nameInput.value = defaultImageFileName(src);
      nameInput.title = 'Image file name (saved into the working directory)';

      // Confirm button: a check mark to the RIGHT of the input. Its look comes
      // from .chat-image-save-confirm (styles.css) so it follows the app theme.
      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'chat-image-save-confirm';
      confirmBtn.textContent = '✓';
      confirmBtn.title = 'Confirm the name and save the image (Enter)';

      // Cancel button: an X to the RIGHT of the confirm button. Closes the
      // editor without saving and restores the Save button.
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'chat-image-save-cancel';
      cancelBtn.textContent = '✕';
      cancelBtn.title = 'Cancel (Escape)';

      const errorLine = document.createElement('div');
      errorLine.className = 'chat-image-save-error';

      let saving = false;

      const closeEditor = (): void => {
        editor.remove();
        saveBtn.style.display = '';
      };

      const showError = (msg: string): void => {
        errorLine.textContent = msg;
        nameInput.focus();
        try { nameInput.select(); } catch { /* ignore */ }
      };

      // Save under the typed name. An existing file makes the save FAIL.
      const doSave = async (): Promise<void> => {
        if (saving) return;

        const raw = nameInput.value.trim();
        if (!raw) {
          showError('Please enter a file name.');
          return;
        }
        const fileName = normalizeImageFileName(raw, src);

        saving = true;
        confirmBtn.disabled = true;
        errorLine.textContent = '';

        try {
          // 1) A name conflict must make the save fail: check the working
          //    directory (case-insensitive) BEFORE writing anything.
          let dir = '';
          try {
            dir = await window.axle.getWorkingDir(modelName);
          } catch (e) {
            console.warn('[axle] getWorkingDir failed:', e);
            dir = '';
          }

          if (dir) {
            let existing: { name: string; type: 'file' | 'folder' }[] = [];
            try {
              existing = await window.axle.listEntries(dir);
            } catch (e) {
              console.warn('[axle] listEntries failed:', e);
              existing = [];
            }
            const target = fileName.toLowerCase();
            if (existing.some((entry) => entry.name.toLowerCase() === target)) {
              showError('"' + fileName + '" already exists in the working directory.');
              return;
            }
          }

          // 2) Ask the main process to write the file under that name.
          // Images (SVG included) are written with fs, so only a LOCAL highlighted
          // folder can be honoured; a remote highlight yields undefined and the
          // save falls back to the working directory (main reports the remote
          // case with its own message).
          const saveTarget = highlightedSaveTarget('local');
          const res = await window.axle.saveImage(src, modelName, fileName, saveTarget);
          if (!res || !res.ok) {
            console.warn('[axle] Save image failed:', res?.error);
            showError(res?.error || 'Failed to save "' + fileName + '".');
            return;
          }

          // 3) Success: close the editor and briefly report it on the button.
          console.log('[axle] Image saved:', res.path);
          closeEditor();
          saveBtn.textContent = 'Saved';
          setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
        } catch (e) {
          console.error('[axle] Save image error:', e);
          showError('Failed to save the image.');
        } finally {
          saving = false;
          confirmBtn.disabled = false;
        }
      };

      // Confirm button (to the RIGHT of the input) triggers the save.
      confirmBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        void doSave();
      });

      // Cancel button (to the RIGHT of the confirm button) closes the editor
      // without saving and restores the Save button.
      cancelBtn.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        closeEditor();
      });

      // Enter confirms; Escape cancels and restores the Save button.
      nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          void doSave();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeEditor();
        }
      });

      // The confirm (check mark) and cancel (X) buttons live in ONE row that
      // never wraps internally, so they always render on the same line. The
      // editor itself may wrap: the input takes the first line and this row
      // follows it when the image (and therefore the editor) is narrow, but
      // the two buttons are never split apart.
      const actionsRow = document.createElement('div');
      actionsRow.className = 'chat-image-save-actions';
      actionsRow.appendChild(confirmBtn);
      actionsRow.appendChild(cancelBtn);

      editor.appendChild(nameInput);
      editor.appendChild(actionsRow);
      editor.appendChild(errorLine);
      wrap.appendChild(editor);

      nameInput.focus();
      try { nameInput.select(); } catch { /* ignore */ }
    };

    // Do not let the Save click bubble up to the image (which would enlarge).
    saveBtn.addEventListener('click', (ev: MouseEvent) => {
      ev.stopPropagation();
      openSaveEditor();
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

/** Values collected from a model configuration form. */
interface ModelFormValues {
  name: string;
  url: string;
  key: string;
  model: string;
  skillsFolder: string;
  responses: boolean;
}

/** Options accepted by buildModelForm(). */
interface ModelFormOptions {
  /** Initial field values: edit mode pre-fills the existing configuration. */
  values?: Partial<ModelConfig>;
  /**
   * When true the Name field is rendered READ-ONLY. The model name is the
   * immutable key of the configuration, so the edit dialog locks it while
   * every other setting stays editable.
   */
  lockName?: boolean;
  /** Label of the submit button ('Add LLM' for the new page, 'Save' to edit). */
  submitLabel?: string;
  /** Extra buttons rendered to the RIGHT of Submit (e.g. Cancel). */
  extraActions?: HTMLElement[];
  /** Invoked on submit with the collected values; may be async. */
  onSubmit: (values: ModelFormValues) => Promise<void> | void;
}

/** The parts of a built model form its caller may need to reach. */
interface ModelFormHandle {
  form: HTMLFormElement;
  submitBtn: HTMLButtonElement;
  /** Show an inline message under the actions (error styling when isError). */
  setStatus: (message: string, isError?: boolean) => void;
}

/**
 * Build the model configuration form shared by the 'New LLM' page and the
 * per-tab edit dialog. It renders exactly the same fields in both places:
 * Name, Base URL, Model, API Key, Skills folder and the Responses API toggle,
 * plus a Submit button and an optional row of extra actions.
 *
 * The 'Model' input carries a chevron button: clicking it asks the MAIN
 * process to list the models the configured Base URL exposes (the
 * OpenAI-compatible /v1/models endpoint, authenticated with the API key in
 * this very form) and shows them as a pick list, so an exact model id never
 * has to be typed by hand. Loading and error states are rendered inside the
 * same menu.
 */
function buildModelForm(options: ModelFormOptions): ModelFormHandle {
  const { values, lockName, onSubmit } = options;

  const form = document.createElement('form');
  form.className = 'config-form';

  const nameField = makeField('Name', 'text', 'e.g. my-llm');
  const urlField = makeField('Base URL', 'text', 'https://api.example.com/v1');
  const keyField = makeField('API Key', 'password', 'sk-...');
  const skillsField = makeField('Skills folder', 'text', 'skills');

  nameField.input.value = values?.name ?? '';
  urlField.input.value = values?.url ?? '';
  keyField.input.value = values?.key ?? '';
  skillsField.input.value = values?.skillsFolder ?? '';

  // In edit mode the name is the immutable KEY of the configuration: it is
  // displayed but cannot be changed (hence readOnly plus a short hint).
  if (lockName) {
    nameField.input.readOnly = true;
    nameField.input.tabIndex = -1;
    nameField.input.classList.add('locked-input');
    nameField.input.title = 'The model name cannot be changed.';
    nameField.group.classList.add('locked-field');

    const lockHint = document.createElement('span');
    lockHint.className = 'field-hint';
    lockHint.textContent = 'The name cannot be changed.';
    nameField.group.appendChild(lockHint);
  }

  // ---- Model field: text input + drop-down chevron ----
  const modelGroup = document.createElement('div');
  modelGroup.className = 'form-group';

  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'Model';

  const modelWrap = document.createElement('div');
  modelWrap.className = 'model-input-wrap';

  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.placeholder = 'model-name-here';
  modelInput.value = values?.model ?? '';

  const modelToggle = document.createElement('button');
  modelToggle.type = 'button';
  modelToggle.className = 'model-input-toggle';
  modelToggle.textContent = '\u25BE'; // small down-pointing triangle
  modelToggle.title = 'Load the models available at the Base URL';
  modelToggle.setAttribute('aria-label', 'Load available models');

  const modelMenu = document.createElement('div');
  modelMenu.className = 'model-menu hidden';

  modelWrap.appendChild(modelInput);
  modelWrap.appendChild(modelToggle);
  modelWrap.appendChild(modelMenu);

  modelGroup.appendChild(modelLabel);
  modelGroup.appendChild(modelWrap);

  // Responses API checkbox
  const respGroup = document.createElement('div');
  respGroup.className = 'form-group checkbox-group';
  const respLabel = document.createElement('label');
  const respInput = document.createElement('input');
  respInput.type = 'checkbox';
  respInput.checked = Boolean(values?.responses);
  respLabel.appendChild(respInput);
  respLabel.appendChild(document.createTextNode(' Use Responses API'));
  respGroup.appendChild(respLabel);

  // Inline status line (validation / save errors)
  const statusLine = document.createElement('div');
  statusLine.className = 'config-status';

  const setStatus = (message: string, isError = false): void => {
    statusLine.textContent = message;
    statusLine.classList.toggle('error', Boolean(message) && isError);
  };

  // Actions row: submit + caller-supplied extra actions (e.g. Cancel).
  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = options.submitLabel ?? 'Add LLM';

  const actions = document.createElement('div');
  actions.className = 'config-actions';
  actions.appendChild(submitBtn);
  for (const extra of options.extraActions ?? []) {
    actions.appendChild(extra);
  }

  form.appendChild(nameField.group);
  form.appendChild(urlField.group);
  form.appendChild(modelGroup);
  form.appendChild(keyField.group);
  form.appendChild(skillsField.group);
  form.appendChild(respGroup);
  form.appendChild(actions);
  form.appendChild(statusLine);

  // ---- Model pick list behaviour ----
  const closeModelMenu = (): void => {
    modelMenu.classList.add('hidden');
    modelMenu.innerHTML = '';
  };

  /** Render a single non-interactive row (loading / error message). */
  const showModelMenuMessage = (text: string, isError: boolean): void => {
    modelMenu.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'model-menu-message' + (isError ? ' error' : '');
    row.textContent = text;
    modelMenu.appendChild(row);
    modelMenu.classList.remove('hidden');
  };

  /** Fetch the available models and render them as a pick list. */
  const loadModels = async (): Promise<void> => {
    // Second click on the chevron closes an already-open menu.
    if (!modelMenu.classList.contains('hidden')) {
      closeModelMenu();
      return;
    }

    const url = urlField.input.value.trim();
    if (!url) {
      showModelMenuMessage('Enter the Base URL first.', true);
      return;
    }

    // Loading state: the chevron is disabled and the menu reports progress.
    modelToggle.disabled = true;
    modelToggle.classList.add('loading');
    showModelMenuMessage('Loading models...', false);

    try {
      const res = await window.axle.listModels(url, keyField.input.value.trim());
      if (!res || !res.ok || !res.models || res.models.length === 0) {
        showModelMenuMessage((res && res.error) || 'No models are available.', true);
        return;
      }

      const current = modelInput.value.trim();
      modelMenu.innerHTML = '';
      for (const id of res.models) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'model-menu-item' + (id === current ? ' selected' : '');
        item.textContent = id;
        item.title = id;
        item.addEventListener('click', (ev: MouseEvent) => {
          ev.stopPropagation();
          modelInput.value = id;
          closeModelMenu();
        });
        modelMenu.appendChild(item);
      }
      modelMenu.classList.remove('hidden');
    } catch (e) {
      console.error('[axle] Failed to list models:', e);
      showModelMenuMessage('Failed to load the model list.', true);
    } finally {
      modelToggle.disabled = false;
      modelToggle.classList.remove('loading');
    }
  };

  modelToggle.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    void loadModels();
  });

  // Clicking anywhere outside the model field closes the pick list.
  document.addEventListener('click', (e: MouseEvent) => {
    if (modelMenu.classList.contains('hidden')) return;
    if (modelWrap.contains(e.target as Node)) return;
    closeModelMenu();
  });

  // ---- Submit ----
  form.addEventListener('submit', async (e: Event) => {
    e.preventDefault();
    setStatus('');

    const collected: ModelFormValues = {
      name: nameField.input.value.trim(),
      url: urlField.input.value.trim(),
      key: keyField.input.value.trim(),
      model: modelInput.value.trim(),
      skillsFolder: skillsField.input.value.trim(),
      responses: respInput.checked,
    };

    if (!collected.name || !collected.model || !collected.url || !collected.key) {
      setStatus('Name, Model, Base URL and API Key are all required.', true);
      return;
    }

    submitBtn.disabled = true;
    try {
      await onSubmit(collected);
    } catch (err) {
      console.error('[axle] Failed to save the model configuration:', err);
      setStatus('Failed to save the configuration.', true);
    } finally {
      submitBtn.disabled = false;
    }
  });

  return { form, submitBtn, setStatus };
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

  // Only offer Cancel when there is at least one model to return to.
  const extraActions: HTMLElement[] = [];
  if (models.length > 0) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'config-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => closeConfigView());
    extraActions.push(cancelBtn);
  }

  // The 'New LLM' page renders the SAME shared form the edit dialog uses, so
  // the two places cannot drift apart.
  let handle: ModelFormHandle | null = null;
  handle = buildModelForm({
    submitLabel: 'Add LLM',
    extraActions,
    onSubmit: async (values) => {
      const name = values.name.trim();

      // A model name is the unique key of the configuration: refuse to add a
      // second entry with a name that is already taken.
      const taken =
        allModels.some((m) => m.name === name) || models.some((m) => m.name === name);
      if (taken) {
        handle?.setStatus('A model named "' + name + '" already exists.', true);
        return;
      }

      const newModel: ModelConfig = {
        name,
        url: values.url,
        key: values.key,
        model: values.model,
        skillsFolder: values.skillsFolder || 'skills',
        responses: values.responses,
      };

      await window.axle.addModel(newModel);
      models = await window.axle.getActiveModels();
      allModels = await window.axle.getModels();
      closeConfigTab();
      buildAllWorkspaces();
      renderTabs();
      switchToModel(name);
    },
  });

  panel.appendChild(handle.form);
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

// ---- Per-model edit dialog ----

/**
 * The single floating edit dialog. Only ONE dialog may exist at a time:
 * opening another (or switching/closing a tab) destroys the previous one.
 */
let editDialog: HTMLElement | null = null;

/** Escape closes the edit dialog. */
function onEditDialogKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    closeEditDialog();
  }
}

/**
 * Close and destroy the floating edit dialog, releasing the document-level
 * listener it installed.
 */
function closeEditDialog(): void {
  document.removeEventListener('keydown', onEditDialogKeydown);
  if (editDialog) {
    editDialog.remove();
    editDialog = null;
  }
}

/**
 * Position the dialog as a popover just BELOW the tab that opened it (or in
 * the top-left corner when no anchor is given), keeping it fully inside the
 * viewport: a dialog opened near the right edge is shifted left instead of
 * overflowing.
 */
function positionEditDialog(dialog: HTMLElement, anchor?: HTMLElement): void {
  const width = 380;
  const margin = 8;

  let left = margin;
  let top = margin;

  if (anchor && anchor.isConnected) {
    const rect = anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
  }

  const maxLeft = window.innerWidth - width - margin;
  if (left > maxLeft) left = Math.max(margin, maxLeft);
  if (left < margin) left = margin;
  if (top < margin) top = margin;

  dialog.style.width = width + 'px';
  dialog.style.left = left + 'px';
  dialog.style.top = top + 'px';
}

/**
 * Dialog mode.
 *
 *   'edit' -- edit an EXISTING model: the Name field is LOCKED (the model name
 *             is the immutable key of the configuration) and the submit button
 *             saves through the axle:updateModel IPC handler.
 *   'copy' -- create a NEW model from an existing one: every value is copied
 *             from the source model, but the Name field starts EMPTY and stays
 *             editable so the user names the new entry; the submit button
 *             creates it through the axle:addModel IPC handler.
 */
type ModelDialogMode = 'edit' | 'copy';

/**
 * Open the floating model dialog for an existing model.
 *
 * Both modes render the SAME form as the 'New LLM' page (buildModelForm), so
 * the three places cannot drift apart; see ModelDialogMode for the differences
 * between editing a model and copying one.
 */
function openModelDialog(mode: ModelDialogMode, modelName: string, anchor?: HTMLElement): void {
  const isCopy = mode === 'copy';

  // Never stack dialogs: a new click replaces the open one.
  closeEditDialog();

  const source =
    allModels.find((m) => m.name === modelName) ??
    models.find((m) => m.name === modelName);

  if (!source) {
    console.warn('[axle] ' + (isCopy ? 'Copy' : 'Edit') + ': unknown model:', modelName);
    return;
  }

  const dialog = document.createElement('div');
  dialog.className = 'edit-dialog';
  dialog.dataset.model = modelName;
  dialog.dataset.mode = mode;
  // Clicks inside the dialog must never reach the outside-click handler below
  // (which would immediately close it again).
  dialog.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); });

  // Header: title + close (×).
  const header = document.createElement('div');
  header.className = 'edit-dialog-header';

  const title = document.createElement('span');
  title.className = 'edit-dialog-title';
  title.textContent = isCopy ? 'Copy LLM Configuration' : 'Edit LLM Configuration';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'edit-dialog-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close (Escape)';
  closeBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    closeEditDialog();
  });

  header.appendChild(title);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  // Cancel button rendered next to Save / Add LLM.
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'config-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    closeEditDialog();
  });

  let handle: ModelFormHandle | null = null;
  handle = buildModelForm({
    // COPY starts from a full copy of the source model except the NAME, which
    // is left EMPTY so the user names the new model before it is created.
    values: isCopy ? { ...source, name: '' } : source,
    lockName: !isCopy,
    submitLabel: isCopy ? 'Add LLM' : 'Save',
    extraActions: [cancelBtn],
    onSubmit: async (values) => {
      if (isCopy) {
        const name = values.name.trim();
        if (!name) {
          handle?.setStatus('Please enter a name for the new model.', true);
          return;
        }

        // A model name is the unique key of a configuration: refuse to create
        // a second entry with a name that is already taken.
        const taken =
          allModels.some((m) => m.name === name) || models.some((m) => m.name === name);
        if (taken) {
          handle?.setStatus('A model named "' + name + '" already exists.', true);
          return;
        }

        try {
          await window.axle.addModel({
            name,
            url: values.url,
            key: values.key,
            model: values.model,
            skillsFolder: values.skillsFolder || 'skills',
            responses: values.responses,
          });

          models = await window.axle.getActiveModels();
          allModels = await window.axle.getModels();
        } catch (err) {
          console.error('[axle] Failed to add the model configuration:', err);
          handle?.setStatus('Failed to save the configuration.', true);
          return;
        }

        closeEditDialog();
        // A brand-new model needs its own workspace panel: drop the temporary
        // config tab, rebuild the workspaces, re-render the tabs and switch to
        // the newly created model.
        closeConfigTab();
        buildAllWorkspaces();
        renderTabs();
        switchToModel(name);
        return;
      }

      try {
        // The NAME is deliberately NOT sent: the main process keys the update
        // on it and refuses to rename an existing entry.
        await window.axle.updateModel(modelName, {
          url: values.url,
          key: values.key,
          model: values.model,
          skillsFolder: values.skillsFolder || 'skills',
          responses: values.responses,
        });

        models = await window.axle.getActiveModels();
        allModels = await window.axle.getModels();
      } catch (err) {
        console.error('[axle] Failed to update the model configuration:', err);
        handle?.setStatus('Failed to save the configuration.', true);
        return;
      }

      closeEditDialog();
      // Model settings do not change the panel layout, but the tab list is
      // re-rendered so anything derived from the configuration stays in sync.
      renderTabs();
    },
  });

  dialog.appendChild(handle.form);

  // Attach to <body> and float it (position: fixed) so the tab bar's overflow
  // cannot clip the popover.
  document.body.appendChild(dialog);
  editDialog = dialog;
  positionEditDialog(dialog, anchor);

  document.addEventListener('keydown', onEditDialogKeydown);

  // In COPY mode focus the (empty) Name field so a name can be typed at once;
  // the Name input is the FIRST input of the shared form.
  if (isCopy) {
    const nameInput = handle.form.querySelector('input') as HTMLInputElement | null;
    if (nameInput) {
      nameInput.focus();
      try { nameInput.select(); } catch { /* ignore */ }
    }
  }

  // Close when clicking anywhere outside the dialog.
  setTimeout(() => {
    const onDocClick = (ev: MouseEvent): void => {
      if (!dialog.contains(ev.target as Node)) {
        closeEditDialog();
        document.removeEventListener('click', onDocClick);
      }
    };
    document.addEventListener('click', onDocClick);
  }, 0);
}

/** Open the dialog in EDIT mode for an existing model (see openModelDialog). */
function openEditDialog(modelName: string, anchor?: HTMLElement): void {
  openModelDialog('edit', modelName, anchor);
}

/**
 * Open the dialog in COPY mode: everything is copied from an existing model
 * except the NAME, which starts EMPTY. Confirming adds a NEW model to the LLM
 * config (window.axle.addModel) and switches to it.
 */
function openCopyDialog(modelName: string, anchor?: HTMLElement): void {
  openModelDialog('copy', modelName, anchor);
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

    // Edit (✎): opens the floating edit dialog for THIS model. The dialog uses
    // the same form as the 'New LLM' page, with the name locked. It is placed
    // BEFORE the label so the tab reads: [✎] [name] [×].
    const edit = document.createElement('span');
    edit.className = 'tab-edit';
    edit.textContent = '\u270E';
    edit.title = 'Edit this LLM configuration';
    edit.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation();
      openEditDialog(model.name, tab);
    });
    tab.appendChild(edit);

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = model.name;
    label.addEventListener('click', () => switchToModel(model.name));
    tab.appendChild(label);

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
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
  addBtn.textContent = '+';
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
  // Any open edit popover belongs to the tab being left behind.
  closeEditDialog();

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
  // An open edit popover belongs to the tab being removed.
  closeEditDialog();

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

// ---- '+ Add' menu icons ----

/** SVG namespace used by every inline menu icon. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** One drawing primitive of an inline icon. */
interface MenuIconPart {
  tag: 'path' | 'rect';
  attrs: Record<string, string>;
}

/**
 * Build one inline SVG icon for the '+ Add' menu.
 *
 * The elements are created with createElementNS (never innerHTML), so the
 * renderer cannot accidentally inject markup, and the drawing strokes with
 * `currentColor`: the icon then follows the surrounding button's colour and
 * its hover state without any extra CSS rule per state.
 */
function createMenuIcon(parts: MenuIconPart[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'menu-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const part of parts) {
    const el = document.createElementNS(SVG_NS, part.tag);
    for (const [name, value] of Object.entries(part.attrs)) {
      el.setAttribute(name, value);
    }
    svg.appendChild(el);
  }

  return svg;
}

/**
 * 'Copy' icon: two overlapping sheets, drawn in the same outline style as the
 * rest of the UI. Used by the per-model Copy button of the '+ Add' menu.
 */
function createCopyIcon(): SVGSVGElement {
  return createMenuIcon([
    { tag: 'rect', attrs: { x: '8', y: '8', width: '14', height: '14', rx: '2', ry: '2' } },
    { tag: 'path', attrs: { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' } },
  ]);
}

/** 'Plus' icon used by the '+ New LLM' action of the same menu. */
function createPlusIcon(): SVGSVGElement {
  return createMenuIcon([
    { tag: 'path', attrs: { d: 'M12 5v14' } },
    { tag: 'path', attrs: { d: 'M5 12h14' } },
  ]);
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
    // One ROW per closed model: the model name (reopen) fills the row and the
    // icon-only 'Copy' button is pinned to its RIGHT EDGE -- the same column
    // every other icon of this menu occupies (see .add-menu-copy and
    // .add-menu-icon-cell in styles.css). Copying opens the SAME dialog as the
    // edit (✎) icon -- every value is pre-filled from this model except the
    // name -- and confirming adds a NEW model to the LLM config.
    const row = document.createElement('div');
    row.className = 'add-menu-row';

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'add-menu-item add-menu-name';
    item.textContent = m.name;
    item.title = 'Reopen ' + m.name;
    item.addEventListener('click', () => {
      closeAddMenu();
      reopenModel(m.name);
    });
    row.appendChild(item);

    // Icon-only Copy button: the label lives in the tooltip / aria-label, the
    // drawing in the inline SVG icon (createCopyIcon, currentColor stroked).
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'add-menu-item add-menu-copy';
    copyBtn.title = 'Copy ' + m.name + ' to a new LLM';
    copyBtn.setAttribute('aria-label', 'Copy ' + m.name + ' to a new LLM');
    copyBtn.appendChild(createCopyIcon());
    copyBtn.addEventListener('click', (ev: MouseEvent) => {
      ev.stopPropagation();
      // The dialog is anchored to the '+ Add' tab button, exactly like the
      // edit popover is anchored to its tab.
      const anchor = document.getElementById('add-tab-btn') ?? undefined;
      closeAddMenu();
      openCopyDialog(m.name, anchor);
    });
    row.appendChild(copyBtn);

    menu.appendChild(row);
  }

  // Divider between the reopen list and the 'create new' action.
  const divider = document.createElement('div');
  divider.className = 'add-menu-divider';
  menu.appendChild(divider);

  // '+ New LLM': the label fills the row and the plus icon sits in the SAME
  // right-hand column as the per-model Copy icons (a single flex button keeps
  // the whole row clickable while its icon stays aligned).
  const newItem = document.createElement('button');
  newItem.type = 'button';
  newItem.className = 'add-menu-item add-menu-new';

  const newLabel = document.createElement('span');
  newLabel.className = 'add-menu-label';
  newLabel.textContent = 'New LLM';
  newItem.appendChild(newLabel);

  const newIconCell = document.createElement('span');
  newIconCell.className = 'add-menu-icon-cell';
  newIconCell.appendChild(createPlusIcon());
  newItem.appendChild(newIconCell);

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

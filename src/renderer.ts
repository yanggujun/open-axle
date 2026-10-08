import 'highlight.js/styles/github.css'
import './styles.css';
import './workingDir.css';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { openLogsWindow } from './logsWindow';
import { openFolderChooser } from './workingDir';
import type { RemoteServer } from './workingDir';

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
}

declare global {
  interface Window {
    axle: {
      getModels(): Promise<ModelConfig[]>;
      getActiveModels(): Promise<ModelConfig[]>;
      addModel(model: ModelConfig): Promise<ModelConfig[]>;
      setModelActive(modelName: string, active: boolean): Promise<boolean>;
      talk(text: string, modelName?: string): Promise<void>;
      switchAgent(modelName: string): Promise<boolean>;
      getSkills(modelName?: string): Promise<string>;
      reload(modelName?: string): Promise<void>;
      clear(modelName?: string): Promise<void>;
      cd(dir: string, modelName?: string): Promise<boolean>;
      stop(modelName?: string): Promise<boolean>;
      validateDir(dir: string): Promise<boolean>;
      getDefaultDir(): Promise<string>;
      listDir(dir: string): Promise<string[]>;
      listRemoteDir(serverName: string, remotePath?: string): Promise<{ path: string; dirs: string[]; error: string }>;
      getRemoteServers(): Promise<RemoteServer[]>;
      getWorkingDir(modelName: string): Promise<string>;
      setWorkingDir(dir: string, modelName: string): Promise<boolean>;
      onBroadcast(cb: (data: AxleBroadcast) => void): () => void;
    };
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
  btnStop: HTMLButtonElement;
  btnSend: HTMLButtonElement;
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

function renderMessageInto(log: HTMLElement, type: string, text: string, format = ''): void {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${type}${format === 'reasoning' ? ' reasoning' : ''}`;
  const time = new Date().toLocaleTimeString();

  msgDiv.innerHTML = `
    <div class="message-header">
      <span class="time">${time}</span>
    </div>
    <div class="message-divider"></div>
    <div class="message-body">${formatBody(text, format)}</div>
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

  // Stop button: sits to the LEFT of 'Change Dir'. It is DISABLED by default
  // and only becomes enabled while this model's continuous task loop is
  // running (driven by the 'stop-state' broadcast from the agent).
  const btnStop = document.createElement('button');
  btnStop.textContent = 'Stop';
  btnStop.className = 'stop-btn';
  btnStop.title = 'Stop the running task loop';
  btnStop.disabled = true;
  styleStopButton(btnStop);

  const btnCd = document.createElement('button');
  btnCd.textContent = 'Change Dir';
  cdControl.appendChild(btnStop);
  cdControl.appendChild(btnCd);
  cdControl.appendChild(dirLabel);

  // Logs button: leftmost control in the button bar. It opens the non-modal
  // floating log window (1/3 screen width, chat-log height, hovered above the
  // chat window) which shows the ENTIRE log file and then follows it live.
  // The log path comes from src/core/logger.ts via the main process bridge.
  const btnLogs = document.createElement('button');
  btnLogs.textContent = 'Logs';
  btnLogs.className = 'logs-btn';
  btnLogs.title = 'Show application logs';
  btnLogs.addEventListener('click', () => openLogsWindow());

  controls.appendChild(btnLogs);
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

  // Input area
  const inputArea = document.createElement('div');
  inputArea.className = 'input-area';
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
  panel.appendChild(inputArea);

  const ws: Workspace = { panel, chatLog, messageInput, dirLabel, btnStop, btnSend };

  // ---- Per-tab event handlers (bound to THIS model name) ----
  const doSend = (): void => {
    const text = messageInput.value.trim();
    if (!text) return;
    renderMessageInto(chatLog, 'user', text);
    messageInput.value = '';
    window.axle.talk(text, modelName);
  };

  btnSend.addEventListener('click', doSend);
  messageInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Do NOT send while the Send button is disabled (the agent is running
      // a task loop -- see handleResponse). This keeps the Enter key in sync
      // with the button so the user cannot queue new input mid-task.
      if (btnSend.disabled) return;
      doSend();
    }
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

  btnCd.addEventListener('click', async () => {
    const chosenDir = await openFolderChooser(modelName);
    if (!chosenDir) return;

    // A remote-server selection ('remote://<name>') is NOT a local path, so it
    // must not be routed through setWorkingDir/cd. Just surface the selection.
    if (chosenDir.startsWith('remote://')) {
      dirLabel.textContent = chosenDir;
      return;
    }

    await window.axle.setWorkingDir(chosenDir, modelName);
    await window.axle.cd(chosenDir, modelName);
    dirLabel.textContent = chosenDir;
  });

  // Stop button: request the agent to break out of its continuous task loop.
  // The button's enabled state is managed by handleResponse() based on the
  // agent's 'running' / 'idle' stop-state broadcasts.
  btnStop.addEventListener('click', () => {
    window.axle.stop(modelName);
  });

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

/**
 * Reflect the Stop button's enabled/disabled state in its appearance.
 * While the button cannot be clicked it is grayed out; when it can be clicked
 * it is shown in its normal color. Called both at creation time and whenever
 * the agent toggles its stop-state ('running' / 'idle').
 */
function styleStopButton(btn: HTMLButtonElement): void {
  // Appearance is driven entirely by the `.stop-btn` / `.stop-btn:disabled`
  // rules in styles.css (applied via the button's :disabled pseudo-class,
  // toggled through the button's `disabled` property). This helper only
  // guarantees the stylesheet class is applied so the CSS takes effect;
  // no inline styling is set here any more.
  btn.classList.add('stop-btn');
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
    // While the conduit reports 'running', gray out both the Stop button
    // (enabled only while running) and the Send button (disabled while
    // running so the user cannot queue new input mid-task). When the
    // conduit reports 'idle' the Send button becomes clickable again.
    const running = data.message === 'running';
    ws.btnStop.disabled = !running;
    styleStopButton(ws.btnStop);
    ws.btnSend.disabled = running;
    return;
  }

  renderMessageInto(ws.chatLog, 'broadcast', data.message, data.format);
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
}

/** Show only the active model's workspace panel; hide the rest (and config). */
function switchToModel(modelName: string): void {
  currentModelName = modelName;
  window.axle.switchAgent(modelName);

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

// ---- Initialization ----
async function init(): Promise<void> {
  window.axle.onBroadcast((data: AxleBroadcast) => handleResponse(data));

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

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AxleAgent } from './core/agent';
import { QueuedConduit, Protocol } from './core/conduit';
import { LlmConfig, ModelConfig } from './core/config';
import { logger } from './core/logger';
import { Tail } from './core/tail';
import { getRemoteServers, resolveSkillConfig } from './core/executor';
import { parsePath } from './core/config';
import { sshExec, SshTarget } from './core/remote';
import { execFile } from 'child_process';

// Webpack entry points (defined by electron-forge's webpack plugin)
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Module-scoped references so the window/agents are not garbage-collected.
let win: BrowserWindow | null = null;

// ---- Filesystem change watchers (right-dock 'Files' tab) ----
//
// The renderer cannot touch the filesystem, so directory watching happens
// HERE, in the main process. Each watcher observes exactly ONE directory
// (non-recursive), so only the current working directory and the currently
// EXPANDED sub-directories are observed. A Map keyed by the resolved absolute
// path dedupes watchers; `origDir` preserves the exact string the renderer used
// so the change event carries a key the renderer can look up again.
interface DirWatch {
  watcher: fs.FSWatcher;
  timer: NodeJS.Timeout | null;
  webContents: Electron.WebContents;
  origDir: string;
}
const dirWatchers = new Map<string, DirWatch>();

/** Close and forget every directory watcher (window close / app quit). */
function stopAllDirWatchers(): void {
  for (const entry of dirWatchers.values()) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    try { entry.watcher.close(); } catch { /* already gone */ }
  }
  dirWatchers.clear();
}

// One agent per configured LLM model. The key is the model name from .llm.config.
const agents = new Map<string, AxleAgent>();

function createWindow(): void {
  win = new BrowserWindow({
    width: 1000,
    height: 720,
    title: 'Open Axle',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  // Default the window to maximized (max size) on startup.
  win.maximize();

  win.on('closed', () => {
    // Release every filesystem watcher the 'Files' tab opened.
    stopAllDirWatchers();
    win = null;
  });
}

/**
 * Build a single AxleAgent for a model. Each agent gets its OWN QueuedConduit
 * whose subscriber tags every broadcast with this model's name, so the
 * renderer can route responses to the correct tab.
 */
function createAgentFor(model: ModelConfig): AxleAgent {
  const c = new QueuedConduit();
  c.subscribe(async (data: Protocol): Promise<void> => {
    // This closure knows THIS agent's model name; stamp it on every message.
    win?.webContents.send('axle:broadcast', { ...data, modelName: model.name });
  });
  c.start();

  return new AxleAgent(
    model,
    c,
  );
}

/**
 * Initialize one AxleAgent per ACTIVE model configured in .llm.config.
 * Inactive (closed) models are skipped. If no active models exist, no agents
 * are created and the renderer shows the config page.
 */
function initAgents(): void {
  try {
    const llmConfig = new LlmConfig();
    for (const model of llmConfig.getActiveModels()) {
      agents.set(model.name, createAgentFor(model));
    }
  } catch (error) {
    logger.log(`Failed to initilize agents ${error}`)
    console.error('[axle] Failed to initialize agents:', error);
  }
}

/** Register IPC handlers that delegate to the appropriate agent. */
function registerIpc(): void {
  // ---- Multi-model configuration ----

  ipcMain.handle('axle:getModels', (): ModelConfig[] => {
    try {
      const llmConfig = new LlmConfig();
      return llmConfig.getModels() ?? [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('axle:addModel', (_e, rawModel: ModelConfig): ModelConfig[] => {
    try {
      const llmConfig = new LlmConfig();
      // Normalize: ensure the required fields are present.
      const model: ModelConfig = {
        name: String(rawModel.name ?? ''),
        url: String(rawModel.url ?? ''),
        key: String(rawModel.key ?? ''),
        model: String(rawModel.model ?? ''),
        skillsFolder: String(rawModel.skillsFolder ?? 'skills'),
        responses: Boolean(rawModel.responses ?? false),
      };

      if (!model.name || !model.url || !model.key || !model.model) {
        throw new Error('Incomplete model configuration.');
      }

      llmConfig.addModel(model);

      // Register an agent for a newly added ACTIVE model so its tab's controls
      // (Get Skills / Reload / Clear / Send) target the correct model instead
      // of falling back to another tab's agent.
      const added = llmConfig.getModel(model.name) ?? model;
      if (added.active !== false && !agents.has(added.name)) {
        agents.set(added.name, createAgentFor(added));
      }

      return llmConfig.getModels() ?? [];
    } catch (error) {
      console.error('[axle] Failed to add model:', error);
      dialog.showErrorBox('Error', 'Unable to add the LLM \"' + (rawModel?.name ?? '') + '\". Check the configuration.');
      return new LlmConfig().getModels() ?? [];
    }
  });

  // Return only the ACTIVE (open) models. Used by the renderer to build tabs.
  ipcMain.handle('axle:getActiveModels', (): ModelConfig[] => {
    try {
      return new LlmConfig().getActiveModels();
    } catch {
      return [];
    }
  });

  // Toggle a model's active (open) flag. On activate we lazily create the agent
  // if it is missing; on deactivate we remove the agent from the map.
  ipcMain.handle('axle:setModelActive', (_e, modelName: string, active: boolean): boolean => {
    try {
      const cfg = new LlmConfig();
      const ok = cfg.setActive(modelName, active);
      if (active) {
        if (!agents.has(modelName)) {
          const m = cfg.getModel(modelName);
          if (m) {
            agents.set(modelName, createAgentFor(m));
          }
        }
      } else {
        agents.delete(modelName);
      }
      return ok;
    } catch (error) {
      console.error('[axle] Failed to set model active:', error);
      return false;
    }
  });

  // ---- Per-tab chat / control IPC ----

  ipcMain.handle('axle:talk', (_e, text: string, modelName?: string, attachments?: { format: string; content: string }[]) => {
    const agent = resolveAgent(modelName);
    if (agent) {
      agent.talk({ userinput: text, attachments });
    }
  });

  // Save a model-returned image (given as an image data URL) into the agent's
  // current working directory. The renderer is sandboxed and cannot touch the
  // filesystem, so the write happens here. Remote (ssh://) working dirs are
  // not supported and are reported back to the caller.
  ipcMain.handle('axle:saveImage', (_e, dataUrl: string, modelName?: string) => {
    try {
      if (!dataUrl || typeof dataUrl !== 'string') {
        return { ok: false, error: 'No image data provided' };
      }

      // Resolve the target directory from the agent's working directory.
      const workingDirStr = resolveAgent(modelName)?.getCwd() ?? process.cwd();
      const parsed = parsePath(workingDirStr);
      if (parsed.kind === 'remote') {
        return { ok: false, error: 'Saving images to a remote working directory is not supported yet.' };
      }
      const dir = parsed.path;

      // Parse `data:image/<type>;base64,<payload>`.
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(dataUrl);
      if (!match) {
        return { ok: false, error: 'Unsupported image format (expected a base64 image data URL)' };
      }
      const mime = match[1].toLowerCase();
      const base64 = match[2];

      // Derive the file extension from the mime type.
      let ext = 'png';
      if (mime === 'image/png') ext = 'png';
      else if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
      else if (mime === 'image/webp') ext = 'webp';
      else if (mime === 'image/gif') ext = 'gif';
      else if (mime === 'image/svg+xml') ext = 'svg';
      else ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '') || 'png';

      // Timestamped, unique-enough file name.
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const fileName = `image-${stamp}.${ext}`;
      const fullPath = path.join(dir, fileName);

      fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));

      return { ok: true, path: fullPath, fileName };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to save image:', msg);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('axle:switchAgent', (_e, modelName: string) => {
    // Switching is mostly a UI-side operation, but we verify the agent exists.
    // The tab will become the active one in the renderer.
    return agents.has(modelName);
  });

  ipcMain.handle('axle:getSkills', (_e, modelName?: string) => {
    const agent = resolveAgent(modelName);
    return agent?.getSkills() ?? 'No active model.';
  });

  ipcMain.handle('axle:reload', (_e, modelName?: string) => {
    const agent = resolveAgent(modelName);
    agent?.reload();
  });

  ipcMain.handle('axle:clear', (_e, modelName?: string) => {
    const agent = resolveAgent(modelName);
    agent?.clear();
  });

  ipcMain.handle('axle:cd', async (_e, dir: string, modelName?: string) => {
    const agent = resolveAgent(modelName);
    if (agent) {
      await agent.cd(dir);
    }
    return true;
  });

  // Request the running continuous task loop to stop. Returns whether an
  // agent was found and asked to stop.
  ipcMain.handle('axle:stop', (_e, modelName?: string) => {
    const agent = resolveAgent(modelName);
    if (agent) {
      agent.stop();
      return true;
    }
    return false;
  });

  ipcMain.handle('axle:validateDir', (_e, dir: string) => {
    try {
      // Remote (ssh://) paths do not exist on the local filesystem, so a local
      // fs check would always fail. Treat remote paths as valid here; the
      // remote tab validates them by listing the directory over SSH instead.
      const parsed = parsePath(dir);
      if (parsed.kind === 'remote') {
        return true;
      }
      const ok = fs.existsSync(parsed.path) && fs.statSync(parsed.path).isDirectory();
      if (!ok) {
        dialog.showErrorBox('Error', 'Invalid Directory!');
      }
      return ok;
    } catch {
      dialog.showErrorBox('Error', 'Invalid Directory!');
      return false;
    }
  });

  // Return the default working directory (current working directory of the app).
  ipcMain.handle('axle:getDefaultDir', () => {
    return process.cwd();
  });

  // List subdirectories of a given path (for the folder-selection dialog).
  ipcMain.handle('axle:listDir', (_e, dir: string) => {
    try {
      if (!dir) return [];
      // Remote (ssh://) paths are not on the local filesystem. Do NOT attempt
      // fs.readdirSync on them (that is what produced
      // "ENOENT: no such file or directory, scandir 'ssh://...'"). The remote
      // tab browses these via 'axle:listRemoteDir' over SSH instead.
      const parsed = parsePath(dir);
      if (parsed.kind === 'remote') {
        return [];
      }
      const entries = fs.readdirSync(parsed.path, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
      return dirs;
    } catch (error) {
      console.error('[axle] Failed to list dir:', error);
      return [];
    }
  });

  // List a LOCAL directory's entries as { name, type } for BOTH files and
  // folders, in a stable order (folders first, then files). Used by the
  // right-side dock's 'Files' tab to render the working directory's
  // sub-folders and files as a tree.
  ipcMain.handle('axle:listEntries', (_e, dir: string) => {
    try {
      if (!dir) return [];
      // Remote (ssh://) paths are not on the local filesystem; the 'Files' tab
      // reports them as unavailable rather than attempting a local read.
      const parsed = parsePath(dir);
      if (parsed.kind === 'remote') {
        return [];
      }
      const entries = fs.readdirSync(parsed.path, { withFileTypes: true });
      const mapped = entries.map((e) => ({
        name: e.name,
        type: (e.isDirectory() ? 'folder' : 'file') as 'folder' | 'file',
      }));
      // Folders first, then files; each group sorted case-insensitively.
      mapped.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      return mapped;
    } catch (error) {
      console.error('[axle] Failed to list entries:', error);
      return [];
    }
  });

  // Read the persisted working directory for a model.
  ipcMain.handle('axle:getWorkingDir', (_e, modelName: string) => {
    try {
      const cfg = new LlmConfig();
      return cfg.getWorkingDir(modelName) ?? process.cwd();
    } catch {
      return '';
    }
  });

  // Classify a model's persisted working directory as 'remote' or 'local'.
  // The folder-selection dialog calls this when it opens so it can show the
  // LOCAL tab for a local working dir and the REMOTE tab for an ssh:// one.
  //
  // Returns a serializable descriptor (the resolved `server` config object is
  // intentionally dropped; the renderer only needs the kind/serverName/path):
  //   { kind: 'remote', serverName: string, path: string }  or
  //   { kind: 'local',  path: string }
  ipcMain.handle('axle:getWorkingDirInfo', (_e, modelName?: string) => {
    let workingDir: string;
    try {
      const cfg = new LlmConfig();
      workingDir = (modelName ? cfg.getWorkingDir(modelName) : undefined) ?? process.cwd();
    } catch {
      workingDir = process.cwd();
    }

    try {
      const parsed = parsePath(workingDir);
      return parsed;
    } catch {
      // Unparseable/empty working dir -> treat as local cwd.
      return { kind: 'local', path: process.cwd() };
    }
  });

  // Return the configured remote servers (from the 'ssh'/'scp' skills in
  // .skill.config) for the folder-selection dialog's 'remote' tab drop-down.
  ipcMain.handle('axle:getRemoteServers', () => {
    try {
      return getRemoteServers();
    } catch {
      return [];
    }
  });

  // List sub-directories of a directory on a REMOTE server, over SSH. Used by
  // the folder-selection dialog's 'remote' tab to browse the remote home dir
  // exactly like the local tab. `serverName` matches a RemoteServer.name from
  // getRemoteServers(); the SSH connection details come from getSkillConfig.
  // When `remotePath` is empty we start from the login (home) directory.
  ipcMain.handle('axle:listRemoteDir', async (_e, serverName: string, remotePath?: string, includeFiles?: boolean, modelName?: string) => {
    try {
      // Resolve the SSH connection details from the AGENT's cached full skill
      // config (the agent's Runtime already holds the parsed `.skill.config`),
      // so `.skill.config` is not re-read on every SSH connection. Prefer the
      // 'ssh' skill entry, fall back to 'scp'.
      const skillConfig = resolveAgent(modelName)?.getFullSkillConfig();
      let cfg = skillConfig ? resolveSkillConfig(skillConfig, 'ssh', serverName) : null;
      if (!cfg || Object.keys(cfg).length === 0) {
        cfg = skillConfig ? resolveSkillConfig(skillConfig, 'scp', serverName) : null;
      }
      if (!cfg || Object.keys(cfg).length === 0) {
        return { path: '', dirs: [], error: `Unknown remote server: ${serverName}` };
      }

      const host = cfg.host || '';
      const port = cfg.port || '22';
      const user = cfg.user_name || '';
      const authType = cfg.auth_type || 'password';
      const keyFile = cfg.key_file || '';
      const password = cfg.pass || '';

      if (!host) {
        return { path: '', dirs: [], error: `No host configured for server: ${serverName}` };
      }

      // Single-quote a remote path so it stays safe when embedded in the shell
      // command executed on the remote host (replaces the removed
      // shellSingleQuote helper).
      const quoteRemotePath = (p: string): string => "'" + p.replace(/'/g, "'\\''") + "'";

      // Default to the login (home) dir when no path is supplied. `cd` with no
      // argument goes home; otherwise we cd into the (single-quoted) path.
      const dirExpr = remotePath ? `cd ${quoteRemotePath(remotePath)}` : 'cd';
      // NOTE: with includeFiles=true we deliberately KEEP the trailing '/'
      // that `ls -p` appends to DIRECTORY names, so the renderer can tell
      // folders (name ends with '/') apart from files (name does not) and show
      // the correct icon per entry. Without includeFiles we only want dirs, so
      // we filter to names ending in '/' and strip that marker.
      const remoteCmd = includeFiles
        ? `${dirExpr} && pwd && ls -1Ap`
        : `${dirExpr} && pwd && ls -1Ap | grep '/$' | sed 's#/$##'`;

      // Run the command over a CACHED SSH connection (see src/core/remote.ts)
      // instead of opening a new one per listing. The connection is kept open
      // for the next call and automatically replaced when it has dropped;
      // sshExec retries the command exactly once over a fresh connection if
      // the cached one turned out to be dead.
      const target: SshTarget = { host, port, user, authType, keyFile, password };
      const stdout = await sshExec(target, remoteCmd);

      const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
      const resolvedPath = lines.length > 0 ? lines[0] : (remotePath || '');
      const dirs = lines.slice(1);
      return { path: resolvedPath, dirs, error: '' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to list remote dir:', msg);
      return { path: '', dirs: [], error: msg };
    }
  });

  // ---- Filesystem change watching (right-dock 'Files' tab) ----
  //
  // The 'Files' tab watches ONLY the current working directory and the
  // sub-directories the user has EXPANDED. Each watch observes a single
  // directory (non-recursive); the renderer adds a watch when a folder row is
  // expanded and removes it (plus all its expanded descendants) when it is
  // collapsed. Changes are debounced per directory (~200ms) to coalesce the
  // burst of events an editor/save produces, then pushed to the renderer over
  // 'axle:fsChanged' so it can re-list just that directory.
  const FS_DEBOUNCE_MS = 200;

  ipcMain.handle('axle:watchDir', (e, dir: string): boolean => {
    try {
      if (!dir) return false;
      // Remote (ssh://) paths have no local OS watcher; ignore them.
      const parsed = parsePath(dir);
      if (parsed.kind === 'remote') return false;

      const abs = path.resolve(parsed.path);
      // Already watching: keep the existing watcher (deduped by resolved path).
      if (dirWatchers.has(abs)) return true;

      const sender = e.sender;
      const watcher = fs.watch(abs, { persistent: false }, () => {
        const entry = dirWatchers.get(abs);
        if (!entry) return;
        // Coalesce rapid events into a single notification.
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          if (!entry.webContents.isDestroyed()) {
            entry.webContents.send('axle:fsChanged', { dir: entry.origDir });
          }
        }, FS_DEBOUNCE_MS);
      });

      watcher.on('error', () => {
        // The directory was most likely deleted or renamed: drop quietly.
        const entry = dirWatchers.get(abs);
        if (entry) {
          if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
          try { entry.watcher.close(); } catch { /* already gone */ }
          dirWatchers.delete(abs);
        }
      });

      dirWatchers.set(abs, { watcher, timer: null, webContents: sender, origDir: dir });
      return true;
    } catch (error) {
      console.error('[axle] Failed to watch dir:', error);
      return false;
    }
  });

  ipcMain.handle('axle:unwatchDir', (_e, dir: string): boolean => {
    try {
      if (!dir) return false;
      const parsed = parsePath(dir);
      if (parsed.kind === 'remote') return false;
      const abs = path.resolve(parsed.path);
      const entry = dirWatchers.get(abs);
      if (entry) {
        if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
        try { entry.watcher.close(); } catch { /* already gone */ }
        dirWatchers.delete(abs);
      }
      return true;
    } catch (error) {
      console.error('[axle] Failed to unwatch dir:', error);
      return false;
    }
  });

  // Stop EVERY directory watcher (used when the Files tab is disposed or the
  // working directory changes) so no stale watchers linger.
  ipcMain.handle('axle:unwatchAll', (): boolean => {
    stopAllDirWatchers();
    return true;
  });

  // ---- Log viewer (tail -f) ----
  //
  // The renderer is sandboxed (contextIsolation: true, nodeIntegration: false)
  // and therefore cannot touch the filesystem. The tail -f implementation in
  // src/core/tail.ts is hosted HERE, in the main process, and the log content is
  // streamed to the renderer over the 'axle:logData' channel. The log file path
  // comes from the `logger` singleton (src/core/logger.ts).
  let logTail: Tail | null = null;
  // The conduit that carries the tail's UI-facing events to the renderer.
  let logConduitRef: QueuedConduit | null = null;

  // Absolute path of the log file currently written by the logger,
  // e.g. <cwd>/.logs/2026-09-22-axle.log
  ipcMain.handle('axle:getLogPath', (): string => logger.logFilePath);

  // Start (or restart) tailing the application log. The ENTIRE file is emitted
  // first, then every appended chunk is pushed to the renderer as it happens.
  //
  // The Tail forwards its events through a QueuedConduit (attached via
  // setConduit) rather than wiring tail.on(...) straight to the renderer. The
  // conduit's subscriber stamps each Protocol message as { type, data } on the
  // 'axle:logData' channel, preserving the renderer contract.
  ipcMain.handle('axle:startLogTail', async (): Promise<string> => {
    // Cancel any previous follower before starting a new one.
    if (logTail) {
      await logTail.stop();
      logTail = null;
    }
    if (logConduitRef) {
      logConduitRef.stop();
      logConduitRef = null;
    }


    // Route the tail's events to the renderer through a QueuedConduit.
    const logConduit = new QueuedConduit();
    logConduit.subscribe(async (msg: Protocol): Promise<void> => {
      win?.webContents.send('axle:logData', { type: msg.message, data: msg.content });
    });
    logConduit.start();
    logConduitRef = logConduit;
    const tail = new Tail(logger.logFilePath, logConduit, { follow: true, usePolling: true });
    logTail = tail;

    try {
      await tail.start();
    } catch (error) {
      console.error('[axle] Failed to start log tail:', error);
    }

    return logger.logFilePath;
  });

  // Stop tailing the log and release the file watcher + conduit.
  ipcMain.handle('axle:stopLogTail', async (): Promise<boolean> => {
    if (logTail) {
      await logTail.stop();
      logTail = null;
    }
    if (logConduitRef) {
      logConduitRef.stop();
      logConduitRef = null;
    }
    return true;
  });

  // Persist the working directory for a model and update its agent if alive.
  ipcMain.handle('axle:setWorkingDir', (_e, dir: string, modelName: string) => {
    try {
      const cfg = new LlmConfig();
      const ok = cfg.setWorkingDir(modelName, dir);
      return ok;
    } catch {
      return false;
    }
  });
}

/**
 * Resolve an agent by model name.
 *
 * When a SPECIFIC model name is provided we NEVER fall back to another model's
 * agent: doing so would route one tab's actions (Get Skills / Reload / Clear /
 * Send) to a different tab. If the requested agent is missing but the model
 * exists and is active, we lazily create it so its tab keeps working. Only when
 * NO name is provided do we fall back to the first available agent.
 */
function resolveAgent(modelName?: string): AxleAgent | undefined {
  if (modelName) {
    let agent = agents.get(modelName);
    if (!agent) {
      // Lazily create the agent for an active model that has none yet.
      try {
        const cfg = new LlmConfig();
        const m = cfg.getModel(modelName);
        if (m && m.active !== false) {
          agent = createAgentFor(m);
          agents.set(modelName, agent);
        }
      } catch (error) {
        console.error('[axle] Failed to lazily create agent for', modelName, error);
      }
    }
    return agent;
  }
  // If no name given, fall back to the first available agent.
  return agents.values().next().value as AxleAgent | undefined;
}

process.on('uncaughtException', (err) => {
  console.error('[axle] uncaughtException', err);
});

app.whenReady().then(() => {
  createWindow();
  initAgents();
  registerIpc();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Ensure every directory watcher opened by the 'Files' tab is released when the
// application quits (also covers macOS, where window-all-closed does not quit).
app.on('before-quit', () => {
  stopAllDirWatchers();
});

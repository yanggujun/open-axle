import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as fs from 'fs';
import { AxleAgent } from './core/agent';
import { QueuedConduit, Protocol } from './core/conduit';
import { LlmConfig, ModelConfig } from './core/config';
import { logger } from './core/logger';
import { Tail } from './core/tail';

// Webpack entry points (defined by electron-forge's webpack plugin)
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// Module-scoped references so the window/agents are not garbage-collected.
let win: BrowserWindow | null = null;

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

  win.on('closed', () => {
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

  ipcMain.handle('axle:talk', (_e, text: string, modelName?: string) => {
    const agent = resolveAgent(modelName);
    if (agent) {
      agent.talk(text);
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

  ipcMain.handle('axle:cd', (_e, dir: string, modelName?: string) => {
    const agent = resolveAgent(modelName);
    if (agent) {
      agent.cd(dir);
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
      const ok = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
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
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
      return dirs;
    } catch (error) {
      console.error('[axle] Failed to list dir:', error);
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

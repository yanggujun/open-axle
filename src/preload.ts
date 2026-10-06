import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

/** Model configuration shape (must match src/core/llm.ts). */
export interface ModelConfig {
  name: string;
  url: string;
  key: string;
  model: string;
  skillsFolder: string;
  responses?: boolean;
  active?: boolean;
}

/**
 * Broadcast payload forwarded from the main process to the renderer.
 * modelName identifies which tab/agent the message belongs to.
 */
export interface AxleBroadcast {
  message: string;
  format?: string;
  modelName?: string;
}

/**
 * The API surface exposed to the renderer as `window.axle`. All heavy lifting
 * (AxleAgent, skill discovery/execution, fs, dialog) lives in the MAIN process;
 * the renderer only talks to it over IPC.
 */
const axleApi = {
  /** Return all configured LLM models. */
  getModels: (): Promise<ModelConfig[]> => ipcRenderer.invoke('axle:getModels'),

  /** Add a new model and persist it to .llm.config. Returns the updated list. */
  addModel: (model: ModelConfig): Promise<ModelConfig[]> =>
    ipcRenderer.invoke('axle:addModel', model),

  /** Return only the ACTIVE (open) models. */
  getActiveModels: (): Promise<ModelConfig[]> => ipcRenderer.invoke('axle:getActiveModels'),

  /** Toggle a model's active (open) flag. Returns whether it was updated. */
  setModelActive: (modelName: string, active: boolean): Promise<boolean> =>
    ipcRenderer.invoke('axle:setModelActive', modelName, active),

  /** Send a user message to the agent bound to the given model name. */
  talk: (text: string, modelName: string): Promise<void> =>
    ipcRenderer.invoke('axle:talk', text, modelName),

  /** Switch the active agent/tab to the given model name. */
  switchAgent: (modelName: string): Promise<void> =>
    ipcRenderer.invoke('axle:switchAgent', modelName),

  /** Ask the agent to emit its skills summary (delivered via onBroadcast). */
  getSkills: (modelName: string): Promise<string> => ipcRenderer.invoke('axle:getSkills', modelName),

  /** Reload skills and reset the conversation. */
  reload: (modelName: string): Promise<void> => ipcRenderer.invoke('axle:reload', modelName),

  /** Clear the conversation history. */
  clear: (modelName: string): Promise<void> => ipcRenderer.invoke('axle:clear', modelName),

  /** Change the working directory used by the agent. */
  cd: (dir: string, modelName: string): Promise<boolean> => ipcRenderer.invoke('axle:cd', dir, modelName),

  /**
   * Request that the agent stop its currently running continuous task loop.
   * Returns whether an agent was found for the given model name.
   */
  stop: (modelName?: string): Promise<boolean> => ipcRenderer.invoke('axle:stop', modelName),

  /** Validate that a path exists and is a directory (dialog shown in main). */
  validateDir: (dir: string): Promise<boolean> =>
    ipcRenderer.invoke('axle:validateDir', dir),

  /** Return the default working directory (from main process). */
  getDefaultDir: (): Promise<string> => ipcRenderer.invoke('axle:getDefaultDir'),

  /** List subdirectories of the given directory. */
  listDir: (dir: string): Promise<string[]> => ipcRenderer.invoke('axle:listDir', dir),

  /** Get the working directory for a model. */
  getWorkingDir: (modelName: string): Promise<string | undefined> =>
    ipcRenderer.invoke('axle:getWorkingDir', modelName),

  /** Set/persist the working directory for a model. */
  setWorkingDir: (dir: string, modelName: string): Promise<boolean> =>
    ipcRenderer.invoke('axle:setWorkingDir', dir, modelName),

  /**
   * Subscribe to broadcasts pushed from the main process. Each payload
   * includes modelName so the renderer can route it to the correct tab.
   */
  onBroadcast: (callback: (data: AxleBroadcast) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, data: AxleBroadcast) => callback(data);
    ipcRenderer.on('axle:broadcast', listener);
    return () => ipcRenderer.removeListener('axle:broadcast', listener);
  },

  /**
   * Absolute path of the application's current log file. It is produced by
   * src/core/logger.ts (the `logger` singleton): <cwd>/.logs/YYYY-MM-DD-axle.log
   */
  getLogPath: (): Promise<string> => ipcRenderer.invoke('axle:getLogPath'),

  /**
   * Start (or restart) tailing the application log in the MAIN process.
   * The whole file is emitted first, then every appended chunk is pushed to
   * the renderer through onLogData. Resolves with the followed file path.
   */
  startLogTail: (): Promise<string> => ipcRenderer.invoke('axle:startLogTail'),

  /** Stop tailing the application log and release the file watcher. */
  stopLogTail: (): Promise<boolean> => ipcRenderer.invoke('axle:stopLogTail'),

  /**
   * Subscribe to live log-stream events pushed from the main process.
   * Mirrors onBroadcast: returns an unsubscribe function.
   */
  onLogData: (
    callback: (data: { type: 'data' | 'error' | 'truncate'; data: string }) => void
  ): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      data: { type: 'data' | 'error' | 'truncate'; data: string }
    ) => callback(data);
    ipcRenderer.on('axle:logData', listener);
    return () => ipcRenderer.removeListener('axle:logData', listener);
  },
};

export type AxleApi = typeof axleApi;

contextBridge.exposeInMainWorld('axle', axleApi);

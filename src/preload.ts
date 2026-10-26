import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { WorkingDir } from './common/common';

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
 * A remote server entry discovered from the 'ssh' / 'scp' skills in
 * .skill.config. Mirrors the RemoteServer interface in src/core/executor.ts.
 * `name` is the config item name used by the ssh/scp skills to look it up.
 */
export interface RemoteServer {
  name: string;
  skill: string;
  host?: string;
  port?: string;
  userName?: string;
  authType?: string;
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

  /**
   * Send a user message to the agent bound to the given model name, with an
   * OPTIONAL list of base64 image attachments ([{ format, content }]).
   */
  talk: (
    text: string,
    modelName?: string,
    attachments?: { format: string; content: string }[]
  ): Promise<void> =>
    ipcRenderer.invoke('axle:talk', text, modelName, attachments),

  /**
   * Save a model-returned image (given as an image data URL) into the agent's
   * current working directory. Returns { ok, path?, fileName?, error? }.
   */
  saveImage: (
    dataUrl: string,
    modelName?: string
  ): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }> =>
    ipcRenderer.invoke('axle:saveImage', dataUrl, modelName),

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

  /**
   * List a LOCAL directory's entries (BOTH files and folders), in a stable
   * order (folders first, then files). Used by the right-side dock's 'Files'
   * tab to render the working directory's sub-folders and files as a tree.
   * Remote (ssh://) paths return an empty array (listing over SSH is handled
   * separately by the folder-selection dialog).
   */
  listEntries: (dir: string): Promise<{ name: string; type: 'file' | 'folder' }[]> =>
    ipcRenderer.invoke('axle:listEntries', dir),

  /**
   * List sub-directories of a directory on a REMOTE server, over SSH. Used by
   * the folder-selection dialog's 'remote' tab to browse the remote home dir
   * exactly like the local tab uses listDir. `serverName` matches a
   * RemoteServer.name from getRemoteServers(); an empty `remotePath` starts
   * from the login (home) directory.
   */
  listRemoteDir: (
    serverName: string,
    remotePath?: string,
    includeFiles?: boolean,
    modelName?: string
  ): Promise<{ path: string; dirs: string[]; error: string }> =>
    ipcRenderer.invoke('axle:listRemoteDir', serverName, remotePath, includeFiles, modelName),

  /** Get the working directory for a model. */
  getWorkingDir: (modelName: string): Promise<string | undefined> =>
    ipcRenderer.invoke('axle:getWorkingDir', modelName),

  /**
   * Classify a model's persisted working directory as 'remote' (an ssh:// URL)
   * or 'local'. Used by the folder-selection dialog to decide which tab to
   * open when it is shown.
   */
  getWorkingDirInfo: (
    modelName?: string
  ): Promise<WorkingDir> => ipcRenderer.invoke('axle:getWorkingDirInfo', modelName),

  /** Set/persist the working directory for a model. */
  setWorkingDir: (dir: string, modelName: string): Promise<boolean> =>
    ipcRenderer.invoke('axle:setWorkingDir', dir, modelName),

  /**
   * Return the list of configured remote servers, extracted from the 'ssh'
   * and 'scp' skills in .skill.config. Used by the folder-selection dialog's
   * 'remote' tab to populate the server drop-down.
   */
  getRemoteServers: (): Promise<RemoteServer[]> =>
    ipcRenderer.invoke('axle:getRemoteServers'),

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

  /**
   * Ask the main process to WATCH a LOCAL directory for filesystem changes
   * (add/remove/rename). Used by the right-side dock's 'Files' tab so it can
   * refresh a listing when the OS reports a change. The watcher observes a
   * single, non-recursive directory: the tab adds one when a folder row is
   * expanded and removes it when the folder is collapsed. Remote (ssh://)
   * paths are ignored by the main process. Resolves true when a watcher is in
   * place (or already existed).
   */
  watchDir: (dir: string): Promise<boolean> => ipcRenderer.invoke('axle:watchDir', dir),

  /**
   * Stop watching a LOCAL directory. Called when a folder row is collapsed (for
   * that folder and every expanded descendant) so no watcher is left running.
   */
  unwatchDir: (dir: string): Promise<boolean> => ipcRenderer.invoke('axle:unwatchDir', dir),

  /**
   * Stop watching EVERY directory. Called when the 'Files' tab is disposed or
   * its working directory changes, releasing all watchers at once.
   */
  unwatchAll: (): Promise<boolean> => ipcRenderer.invoke('axle:unwatchAll'),

  /**
   * Subscribe to filesystem-change events pushed from the main process. Each
   * payload carries the directory (`dir`) that changed, so the tab can re-list
   * just that directory. Mirrors onBroadcast/onLogData: returns an unsubscribe
   * function.
   */
  onFsChanged: (callback: (data: { dir: string }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, data: { dir: string }) => callback(data);
    ipcRenderer.on('axle:fsChanged', listener);
    return () => ipcRenderer.removeListener('axle:fsChanged', listener);
  },
};

export type AxleApi = typeof axleApi;

contextBridge.exposeInMainWorld('axle', axleApi);

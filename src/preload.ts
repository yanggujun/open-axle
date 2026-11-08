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
  /**
   * Sidecar payload carried by the conduit Protocol `content` (e.g. a
   * ready-to-embed `data:` URI for image/file results).
   */
  content?: string;
  /**
   * Conduit Protocol `signal`. When it is 'persistable' the chat log offers
   * hover buttons to save the message into the working directory or into its
   * `.axle` folder as a skill.
   */
  signal?: string;
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

  /**
   * Update an EXISTING model and persist the change. `modelName` is the
   * immutable key: it identifies the entry and is never modified, so only the
   * settings carried by `patch` (url/key/model/skillsFolder/responses) can
   * change. Returns the updated list of all models.
   */
  updateModel: (modelName: string, patch: Partial<ModelConfig>): Promise<ModelConfig[]> =>
    ipcRenderer.invoke('axle:updateModel', modelName, patch),

  /**
   * Ask the MAIN process to list the models a provider exposes, by calling the
   * OpenAI-compatible `<baseUrl>/v1/models` endpoint with the supplied API key
   * (sent as an 'Authorization: Bearer <key>' header).
   * Resolves { ok, models, error }: `models` holds the sorted model ids and
   * `error` is a short message to display when `ok` is false.
   */
  listModels: (
    baseUrl: string,
    apiKey: string
  ): Promise<{ ok: boolean; models: string[]; error?: string }> =>
    ipcRenderer.invoke('axle:listModels', baseUrl, apiKey),

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
   * current working directory. When `fileName` is supplied the image is saved
   * under that name; the MAIN process sanitizes it and REFUSES to overwrite an
   * existing file, in which case it resolves { ok: false, error }.
   * Returns { ok, path?, fileName?, error? }.
   */
  saveImage: (
    dataUrl: string,
    modelName?: string,
    fileName?: string,
    targetDir?: string
  ): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }> =>
    ipcRenderer.invoke('axle:saveImage', dataUrl, modelName, fileName, targetDir),

  /**
   * Save the text of a 'persistable' chat message into the agent's working
   * directory under a user-chosen name. With `asSkill` true the file is
   * written into `<workingDir>/.axle` instead (the folder is created when it
   * does not exist). LOCAL and remote (ssh://) working dirs are both
   * supported; an existing file is never overwritten, in which case it
   * resolves { ok: false, error }.
   */
  savePromptFile: (
    content: string,
    modelName?: string,
    fileName?: string,
    asSkill?: boolean,
    targetDir?: string
  ): Promise<{ ok: boolean; path?: string; fileName?: string; error?: string }> =>
    ipcRenderer.invoke('axle:savePromptFile', content, modelName, fileName, asSkill, targetDir),

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

  /**
   * Ask the MAIN process whether a file may be opened in the 'Files' tab's
   * 'Edit' dialog. The renderer cannot perform this check itself: the shared
   * helpers in src/common/common.ts import fs, so they only run in main.
   *
   * A file is editable only when its extension is whitelisted AND its leading
   * bytes look like text; binary files and remote (ssh://) paths are refused.
   * Resolves with the verdict and, when refused, a short reason to display.
   */
  canEditFile: (
    filePath: string,
    modelName?: string
  ): Promise<{ editable: boolean; reason: string }> =>
    ipcRenderer.invoke('axle:canEditFile', filePath, modelName),

  /**
   * Read a file as RAW text for the 'Edit' dialog. Unlike the read skills this
   * applies NO markdown code fence and NO CSV table rendering, so the text is
   * safe to load straight into an editable buffer.
   * Resolves { ok: true, content } or { ok: false, error }.
   */
  readFileRaw: (
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('axle:readFileRaw', filePath, modelName),

  /**
   * Persist text edited in the 'Edit' dialog. The write happens in main
   * because the renderer is sandboxed; the 'Files' tab's directory watcher
   * then refreshes the listing automatically.
   * Resolves { ok: true } or { ok: false, error }.
   */
  writeFileRaw: (
    filePath: string,
    content: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('axle:writeFileRaw', filePath, content, modelName),

  /**
   * Ask the MAIN process whether a file may be shown by the 'Files' tab's
   * 'View' menu item. Like canEditFile the verdict must be computed in main,
   * because the image whitelist (IMAGE_EXTENSION_MIME_MAP in
   * src/common/common.ts) lives in a module that imports fs. Only the file's
   * extension is inspected, so the answer is available for LOCAL files and
   * remote (ssh://) paths alike, without opening an SSH connection.
   * Resolves with the verdict and, when refused, a short reason to display.
   */
  canViewFile: (
    filePath: string,
    modelName?: string
  ): Promise<{ viewable: boolean; reason: string }> =>
    ipcRenderer.invoke('axle:canViewFile', filePath, modelName),

  /**
   * Read an image file for the 'View' dialog and return its bytes as base64
   * together with the MIME type, so the renderer can build a data: URI. LOCAL
   * files are read from disk; ssh:// paths are fetched over the cached SFTP
   * session. Non-image extensions are refused by main.
   * Resolves { ok: true, base64, mimeType } or { ok: false, error }.
   */
  readImageFile: (
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; base64?: string; mimeType?: string; error?: string }> =>
    ipcRenderer.invoke('axle:readImageFile', filePath, modelName),

  /**
   * Create an EMPTY file at `filePath` for the 'Files' tab's New File action.
   * An existing file is never truncated. LOCAL paths are created with fs;
   * ssh:// paths are created over the CACHED SFTP session.
   * Resolves { ok: true } or { ok: false, error }.
   */
  createFile: (
    filePath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('axle:createFile', filePath, modelName),

  /**
   * Create a single folder at `dirPath` for the 'Files' tab's New Folder
   * action. Creation is NOT recursive, so an existing folder is reported as an
   * error instead of being silently accepted. ssh:// paths go over the CACHED
   * SFTP session.
   * Resolves { ok: true } or { ok: false, error }.
   */
  createFolder: (
    dirPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('axle:createFolder', dirPath, modelName),

  /**
   * Copy a FILE to `destPath` for the 'Files' tab's Copy File action. Folders
   * are refused, an existing destination is never overwritten, and both paths
   * must live in the same world (local -> local, or remote -> remote on the
   * same server). Remote copies ride the CACHED SFTP session.
   * Resolves { ok: true } or { ok: false, error }.
   */
  copyFile: (
    srcPath: string,
    destPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('axle:copyFile', srcPath, destPath, modelName),

  /**
   * Copy a file OR a folder, recursively, for the 'Files' tab's Paste action.
   * Unlike copyFile this accepts folders and EVERY world combination: local ->
   * local, remote -> remote on the same server, local -> remote and remote ->
   * local. An existing destination is never overwritten: the entry is stored
   * under the next free name ('name copy', 'name copy 2', ...) and the final
   * path is reported back in `path` (ssh:// prefixed when remote).
   * Resolves { ok: true, path } or { ok: false, error }.
   */
  copyEntry: (
    srcPath: string,
    destPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string; path?: string }> =>
    ipcRenderer.invoke('axle:copyEntry', srcPath, destPath, modelName),

  /**
   * Local files currently on the OPERATING SYSTEM clipboard, so the Files tab's
   * Paste can copy entries that were copied in another application. Remote
   * (ssh://) paths have no OS form and are never reported.
   * Resolves { ok, files } (files is empty when the clipboard holds no files).
   */
  getClipboardFiles: (): Promise<{ ok: boolean; files: string[]; error?: string }> =>
    ipcRenderer.invoke('axle:getClipboardFiles'),

  /**
   * Put LOCAL files on the OPERATING SYSTEM clipboard so the Files tab's Copy can
   * be pasted in Explorer/Finder and survives an app restart. Remote paths are
   * refused by the main process.
   * Resolves { ok } or { ok: false, error }.
   */
  setClipboardFiles: (paths: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('axle:setClipboardFiles', paths),

  /**
   * Delete a file, or a folder together with everything inside it, for the
   * 'Files' tab's Delete action. LOCAL paths use fs; ssh:// paths are removed
   * over the CACHED SFTP session, depth-first.
   * Resolves { ok: true } or { ok: false, error }.
   */
  deleteEntry: (
    targetPath: string,
    modelName?: string
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('axle:deleteEntry', targetPath, modelName),
};

export type AxleApi = typeof axleApi;

contextBridge.exposeInMainWorld('axle', axleApi);

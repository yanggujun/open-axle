import { app, BrowserWindow, ipcMain, dialog, clipboard, ClipboardItem } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AxleAgent } from './core/agent';
import { QueuedConduit, Protocol } from './core/conduit';
import { LlmConfig, ModelConfig } from './core/config';
import { logger } from './core/logger';
import { Tail } from './core/tail';
import { getRemoteServers, resolveSkillConfig } from './core/executor';
import { parsePath } from './core/config';
import { buildSshCacheKey, buildSshConnectConfig, getSshConn, sshExec, SshTarget } from './core/remote';
import { execFile } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import {
  CODE_EXTENSION_LANGUAGE_MAP,
  IMAGE_EXTENSION_MIME_MAP,
  PURE_TEXT_EXTENSION_MIME_MAP,
  TEXT_EXTENSION_MIME_MAP,
  getSftp,
  isProbablyTextBuffer,
  isProbablyTextFile,
  sftpReadFileBuffer,
  sftpWriteFile,
  sftpMkdir,
  remoteFileExists
} from './common/common';

// Webpack entry points (defined by electron-forge's webpack plugin)
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

// ---------------------------------------------------------------------------
// Application icon
// ---------------------------------------------------------------------------
//
// resources/app-icon.svg is the single source of truth for the app icon, but
// Electron cannot consume an SVG at runtime. `scripts/make-icons.js` rasterises
// it to resources/app-icon.png (512x512) and to the platform assets that are
// embedded at PACKAGE time (build/app-icon.ico for Windows executables and
// build/app-icon.icns for the macOS bundle, wired through forge.config.ts
// `packagerConfig.icon`).
//
// This helper resolves the PNG that the running app uses for the WINDOW icon
// and, on macOS, the Dock icon. Two layouts must be covered:
//   - dev (`npm start`): __dirname is .webpack/main, so the PNG is two levels
//     up in the project's resources/ folder;
//   - packaged: extraResource in forge.config.ts copies resources/app-icon.png
//     next to app.asar, i.e. process.resourcesPath/app-icon.png.
function getAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.png')
    : path.join(__dirname, '..', '..', 'resources', 'app-icon.png');
}

// Windows groups taskbar buttons per AppUserModelID. Without an explicit id the
// window is grouped under electron.exe and shows Electron's icon instead of the
// app icon, even though the executable itself carries the icon.
if (process.platform === 'win32') {
  app.setAppUserModelId('Open-Axle');
}

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
    // Runtime window icon (taskbar + title bar on Windows, window icon on
    // Linux). On macOS the Dock icon is set separately in whenReady().
    icon: getAppIconPath(),
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

/**
 * Register IPC handlers that delegate to the appropriate agent.
 */

// ---- Remote file editing (ssh:// paths) ----
//
// Files on an SSH host cannot be reached with the local fs helpers, so they are
// read and written over SFTP. The sessions below ride on the SAME cached SSH
// connection the directory listing uses (src/core/remote.ts: getSshConn +
// buildSshConnectConfig), and the session itself is cached per target, so
// repeated edits do not pay for a new handshake.

/** Open SFTP sessions, keyed by the SSH cache key of their target. */
const remoteSftpCache = new Map<string, any>();

/** Bytes inspected when sniffing a REMOTE file to decide whether it is text. */
const REMOTE_SNIFF_BYTES = 8192;

/**
 * Resolve a remote server name to an SSH target descriptor, using the AGENT's
 * cached skill config (the 'ssh' skill entry, falling back to 'scp') - the same
 * lookup the axle:listRemoteDir handler performs.
 */
function resolveRemoteTarget(
  serverName: string | null,
  modelName?: string
): { target?: SshTarget; key?: string; error?: string } {
  if (!serverName) {
    return { error: 'No server name'};
  }
  const skillConfig = resolveAgent(modelName)?.getFullSkillConfig();
  let cfg = skillConfig ? resolveSkillConfig(skillConfig, 'ssh', serverName) : null;
  if (!cfg || Object.keys(cfg).length === 0) {
    cfg = skillConfig ? resolveSkillConfig(skillConfig, 'scp', serverName) : null;
  }
  if (!cfg || Object.keys(cfg).length === 0) {
    return { error: `Unknown remote server: ${serverName}` };
  }

  const host = cfg.host || '';
  if (!host) {
    return { error: `No host configured for server: ${serverName}` };
  }

  const target: SshTarget = {
    host,
    port: cfg.port || '22',
    user: cfg.user_name || '',
    authType: cfg.auth_type || 'password',
    keyFile: cfg.key_file || '',
    password: cfg.pass || ''
  };

  return { target, key: buildSshCacheKey(target) };
}

/**
 * Return a live SFTP session for the target, opening one over the cached SSH
 * connection when none is cached. The caller must NOT close the session: it is
 * reused by later calls and evicted automatically when the transport dies.
 */
async function getRemoteSftp(target: SshTarget, key: string): Promise<any> {
  const cached = remoteSftpCache.get(key);
  if (cached) return cached;

  const client = await getSshConn(key, buildSshConnectConfig(target));
  const sftp = await getSftp(client);
  remoteSftpCache.set(key, sftp);

  // Forget the session as soon as the transport goes away so the NEXT call
  // rebuilds it instead of failing on a dead channel.
  const forget = (): void => {
    if (remoteSftpCache.get(key) === sftp) remoteSftpCache.delete(key);
  };
  try {
    sftp.on('close', forget);
    sftp.on('end', forget);
    sftp.on('error', forget);
  } catch {
    // Not every sftp wrapper exposes all events; a failed call still evicts.
  }

  return sftp;
}

/** Forget a cached SFTP session (used when a call fails mid-flight). */
function dropRemoteSftp(key: string): void {
  remoteSftpCache.delete(key);
}

/**
 * Read only the FIRST `bytes` of a remote file, for the text/binary sniff.
 * Streaming with an explicit end offset keeps the check cheap even for a large
 * file: nothing beyond the requested range is transferred.
 */
function sftpReadHead(sftp: any, remotePath: string, bytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      fn();
    };

    let stream: any;
    try {
      // `end` is INCLUSIVE in ssh2's read stream, hence bytes - 1.
      stream = sftp.createReadStream(remotePath, { start: 0, end: Math.max(0, bytes - 1) });
    } catch (error) {
      reject(error);
      return;
    }

    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    stream.on('error', (error: Error) => settle(() => reject(error)));
    stream.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    stream.on('close', () => settle(() => resolve(Buffer.concat(chunks))));
  });
}

/**
 * Build the absolute URL used to list the models a provider exposes.
 *
 * The base URL is accepted in every shape users actually paste: with or
 * without a trailing slash, and with or without the trailing `/v1` (which is
 * what the 'Base URL' field asks for). Both forms resolve to
 * `<base>/v1/models`, the OpenAI-compatible endpoint.
 */
function buildModelsUrl(baseUrl: string): string {
  let url = String(baseUrl ?? '').trim();
  // Drop every trailing slash.
  url = url.replace(/\/+$/, '');
  if (!url) return '';
  // Append /v1 only when the base URL does not already carry an API version.
  if (!/\/v\d+$/.test(url)) {
    url += '/v1';
  }
  return url + '/models';
}

/**
 * Minimal HTTP(S) GET that resolves with the response body as text. Used by
 * the 'list models' handler: the renderer is sandboxed, so it cannot call a
 * provider URL itself. A non-2xx status or a broken request resolves with
 * ok=false and a short, user-displayable error (no exception is thrown).
 */
function httpGetText(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, body: '', error: 'Invalid URL: ' + url });
      return;
    }

    const transport = target.protocol === 'http:' ? http : https;
    let settled = false;
    const settle = (result: { ok: boolean; status: number; body: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = transport.request(target, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          settle({ ok: true, status, body });
        } else {
          settle({ ok: false, status, body, error: 'HTTP ' + status });
        }
      });
      res.on('error', (error: Error) => {
        settle({ ok: false, status: 0, body: '', error: String(error) });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      settle({ ok: false, status: 0, body: '', error: 'The request timed out.' });
    });
    req.on('error', (error: Error) => {
      settle({ ok: false, status: 0, body: '', error: String(error) });
    });

    req.end();
  });
}

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

  // Update an EXISTING model. The model NAME is the immutable key: it locates
  // the entry and is never changed here, so the renderer may only edit the
  // remaining settings (Base URL, Model, API Key, Skills folder, Responses).
  // The agent bound to this model is rebuilt when it exists, so a changed URL,
  // key or model name takes effect immediately without restarting the app.
  ipcMain.handle('axle:updateModel', (_e, modelName: string, patch: Partial<ModelConfig>): ModelConfig[] => {
    try {
      const llmConfig = new LlmConfig();
      const name = String(modelName ?? '').trim();
      if (!name) {
        throw new Error('Missing model name.');
      }

      const current = llmConfig.getModel(name);
      if (!current) {
        throw new Error('Unknown model: ' + name);
      }

      // Normalize the incoming patch; the name is deliberately excluded.
      const normalized: Partial<ModelConfig> = {};
      if (patch?.url !== undefined) normalized.url = String(patch.url).trim();
      if (patch?.key !== undefined) normalized.key = String(patch.key).trim();
      if (patch?.model !== undefined) normalized.model = String(patch.model).trim();
      if (patch?.skillsFolder !== undefined) {
        normalized.skillsFolder = String(patch.skillsFolder).trim() || 'skills';
      }
      if (patch?.responses !== undefined) normalized.responses = Boolean(patch.responses);

      // Required connection fields must stay non-empty after the edit.
      const nextUrl = normalized.url ?? current.url;
      const nextKey = normalized.key ?? current.key;
      const nextModel = normalized.model ?? current.model;
      if (!nextUrl || !nextKey || !nextModel) {
        throw new Error('Incomplete model configuration.');
      }

      const updated = llmConfig.updateModel(name, normalized);
      if (!updated) {
        throw new Error('Unable to update the model.');
      }

      // Rebuild this model's agent so the new settings are picked up.
      if (updated.active !== false) {
        agents.set(name, createAgentFor(updated));
      }

      return llmConfig.getModels() ?? [];
    } catch (error) {
      console.error('[axle] Failed to update model:', error);
      dialog.showErrorBox('Error', 'Unable to update the LLM \"' + (modelName ?? '') + '\". Check the configuration.');
      return new LlmConfig().getModels() ?? [];
    }
  });

  // List the models a provider exposes, so the 'Model' input can offer a
  // drop-down instead of forcing the user to type an exact model id.
  // Calls the OpenAI-compatible `<base>/v1/models` endpoint with the supplied
  // API key. Resolves { ok, models, error }: `models` is the sorted list of
  // ids from the response `data[].id` array; `error` is a short message meant
  // to be shown in the UI when ok is false.
  ipcMain.handle('axle:listModels', async (
    _e,
    baseUrl: string,
    apiKey: string
  ): Promise<{ ok: boolean; models: string[]; error?: string }> => {
    try {
      const url = buildModelsUrl(baseUrl);
      if (!url) {
        return { ok: false, models: [], error: 'Please enter a Base URL first.' };
      }

      const headers: Record<string, string> = { Accept: 'application/json' };
      const key = String(apiKey ?? '').trim();
      if (key) {
        headers.Authorization = 'Bearer ' + key;
      }

      const res = await httpGetText(url, headers, 15000);
      if (!res.ok) {
        return {
          ok: false,
          models: [],
          error: res.error ? (res.error + ' (' + url + ')') : ('Failed to reach ' + url),
        };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        return { ok: false, models: [], error: 'The server did not return valid JSON.' };
      }

      // OpenAI-compatible shape: { data: [ { id: 'model-name' }, ... ] }.
      const list: any[] = Array.isArray(parsed?.data)
        ? parsed.data
        : (Array.isArray(parsed?.models) ? parsed.models : []);

      const models: string[] = [];
      for (const item of list) {
        const id = typeof item === 'string' ? item : (item?.id ?? item?.name);
        if (id && typeof id === 'string' && !models.includes(id)) {
          models.push(id);
        }
      }

      if (models.length === 0) {
        return { ok: false, models: [], error: 'The server returned no models.' };
      }

      models.sort((a, b) => a.localeCompare(b));
      return { ok: true, models };
    } catch (error) {
      console.error('[axle] Failed to list models:', error);
      return { ok: false, models: [], error: String(error) };
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

  // Turn a renderer-supplied image file name into a SAFE bare file name for
  // the working directory: no directory part, none of the characters that are
  // illegal in file names, no control characters, no leading dots, and always
  // carrying an image extension (appended from the image mime type when the
  // supplied name has none or is not an image extension).
  const sanitizeImageFileName = (raw: string, fallbackExt: string): string => {
    let name = String(raw || '');
    // Drop any directory part (both separators) the renderer may have sent.
    name = name.split('/').join('');
    name = name.split('\\').join('');
    // Drop characters that are illegal in file names + control characters.
    name = name.replace(/[<>:"|?*]/g, '');
    name = name.replace(/[\u0000-\u001f]/g, '');
    // No leading dots (hidden / traversal names) and no surrounding blanks.
    name = name.replace(/^\.+/, '').trim();
    if (!name) name = 'image.' + fallbackExt;
    if (!/\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i.test(name)) {
      name += '.' + fallbackExt;
    }
    return name;
  };

  // Save a model-returned image (given as an image data URL) into the agent's
  // current working directory under a name chosen by the user. The renderer is
  // sandboxed and cannot touch the filesystem, so the write happens here.
  // Remote (ssh://) working dirs are not supported and are reported back.
  // An EXPLICITLY named image must never overwrite an existing file: a name
  // clash makes the save fail (the renderer shows the error inline).
  ipcMain.handle('axle:saveImage', (_e, dataUrl: string, modelName?: string, requestedFileName?: string, targetDir?: string) => {
    try {
      if (!dataUrl || typeof dataUrl !== 'string') {
        return { ok: false, error: 'No image data provided' };
      }

      // The destination folder can be overridden by the caller (the folder
      // HIGHLIGHTED in the Files tab), so a save lands where the user pointed
      // instead of always in the agent's working directory. The override is
      // validated HERE because the renderer may name any path: a remote folder is
      // refused (image saving has no SFTP path yet) and a folder that no longer
      // exists is reported rather than silently falling back.
      const overrideDir = typeof targetDir === 'string' ? targetDir.trim() : '';
      let dir: string;
      if (overrideDir) {
        const overrideParsed = parsePath(overrideDir);
        if (overrideParsed.kind === 'remote') {
          return { ok: false, error: 'Saving images to a remote directory is not supported yet.' };
        }
        let overrideIsDir = false;
        try {
          overrideIsDir = fs.statSync(overrideParsed.path).isDirectory();
        } catch {
          overrideIsDir = false;
        }
        if (!overrideIsDir) {
          return { ok: false, error: 'The target folder no longer exists.' };
        }
        dir = overrideParsed.path;
      } else {
        // No override: keep using the agent's working directory.
        const workingDirStr = resolveAgent(modelName)?.getCwd() ?? process.cwd();
        const parsed = parsePath(workingDirStr);
        if (parsed.kind === 'remote') {
          return { ok: false, error: 'Saving images to a remote working directory is not supported yet.' };
        }
        dir = parsed.path;
      }

      // Two data-URL shapes are accepted here:
      //   1) `data:image/<type>;base64,<payload>` -- raster images (and any
      //      caller that already produced base64);
      //   2) `data:image/<type>[;<params>],<payload>` where the payload is
      //      percent-encoded / utf8 text. SVG is an XML *text* format, so the
      //      renderer sends it this way; a base64-only parser rejects it
      //      (the 'not a base64 string' error when saving SVG files).
      // As a last resort, raw SVG/XML markup (starting with '<') is accepted.
      // Every accepted form is normalised to base64 so the single decode path
      // below (Buffer.from(base64, 'base64')) keeps working unchanged.
      let mime: string;
      let base64: string;
      const base64Match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(dataUrl);
      if (base64Match) {
        mime = base64Match[1].toLowerCase();
        // Drop any whitespace/newlines (e.g. pretty-printed SVG base64).
        base64 = base64Match[2].replace(/\s+/g, '');
      } else {
        const textMatch = /^data:(image\/[a-zA-Z0-9.+-]+)(?:;[^,]*)?,([\s\S]*)$/.exec(dataUrl);
        let svgText: string;
        if (textMatch) {
          mime = textMatch[1].toLowerCase();
          const rawPayload = textMatch[2];
          try {
            svgText = decodeURIComponent(rawPayload);
          } catch {
            // Not percent-encoded: use the payload verbatim.
            svgText = rawPayload;
          }
        } else if (dataUrl.trim().startsWith('<')) {
          // Raw SVG/XML markup supplied directly.
          mime = 'image/svg+xml';
          svgText = dataUrl;
        } else {
          return { ok: false, error: 'Unsupported image format (expected an image data URL or SVG markup)' };
        }
        base64 = Buffer.from(svgText, 'utf8').toString('base64');
      }

      // Derive the file extension from the mime type.
      let ext = 'png';
      if (mime === 'image/png') ext = 'png';
      else if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
      else if (mime === 'image/webp') ext = 'webp';
      else if (mime === 'image/gif') ext = 'gif';
      else if (mime === 'image/svg+xml') ext = 'svg';
      else ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/g, '') || 'png';

      // Use the name supplied by the renderer when there is one; otherwise
      // fall back to the original timestamped name (unchanged behavior).
      const requested = typeof requestedFileName === 'string' ? requestedFileName.trim() : '';
      let fileName: string;
      if (requested) {
        fileName = sanitizeImageFileName(requested, ext);
      } else {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        fileName = `image-${stamp}.${ext}`;
      }
      const fullPath = path.join(dir, fileName);

      const bytes = Buffer.from(base64, 'base64');

      if (requested) {
        // The sanitized name must stay INSIDE the working directory.
        if (path.resolve(path.dirname(fullPath)) !== path.resolve(dir)) {
          return { ok: false, error: 'Invalid image file name.' };
        }

        // Refuse to overwrite: a case-insensitive clash with ANY entry in the
        // working directory makes the save fail and nothing is written.
        let clash = false;
        try {
          clash = fs.readdirSync(dir).some((n: string) => n.toLowerCase() === fileName.toLowerCase());
        } catch {
          clash = false;
        }
        if (!clash) {
          try { clash = fs.existsSync(fullPath); } catch { clash = false; }
        }
        if (clash) {
          return { ok: false, error: '"' + fileName + '" already exists in the working directory.' };
        }

        // 'wx' fails when the path already exists, which also covers the race
        // where the file appears between the check above and this write.
        try {
          fs.writeFileSync(fullPath, bytes, { flag: 'wx' });
        } catch (writeErr) {
          const code = (writeErr as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            return { ok: false, error: '"' + fileName + '" already exists in the working directory.' };
          }
          throw writeErr;
        }
      } else {
        fs.writeFileSync(fullPath, bytes);
      }

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
      // Resolve the SSH connection details through the SHARED resolver (see
      // resolveRemoteTarget above). It performs the lookup this handler used to
      // inline - the AGENT's cached full skill config (the agent's Runtime
      // already holds the parsed `.skill.config`, so it is not re-read per
      // connection), preferring the 'ssh' skill entry and falling back to
      // 'scp' - and returns the same cache key the SFTP-based handlers use.
      // Going through it keeps listing and editing in lockstep, so a future
      // change to credential or permission resolution applies to both.
      const resolved = resolveRemoteTarget(serverName, modelName);
      if (resolved.error || !resolved.target) {
        return {
          path: '',
          dirs: [],
          error: resolved.error || `Unknown remote server: ${serverName}`,
        };
      }
      const target = resolved.target;

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

  // ---- File editing (right-dock 'Files' tab -> 'Edit' dialog) ----
  //
  // The renderer is sandboxed and cannot touch the filesystem, and the shared
  // helpers in src/common/common.ts import fs/ssh2, so they can only run HERE.
  // The three channels below decide whether a file may be edited and perform
  // the raw (un-fenced) text read/write the editor dialog needs.

  // Report whether a file may be opened in the Edit dialog. The gate differs by
  // location:
  //   - LOCAL file: BOTH gates apply, i.e. its extension must be present in one
  //     of the shared text/code maps AND its leading bytes must look like text
  //     (isProbablyTextFile), so a binary file is always refused.
  //   - REMOTE (ssh://) file: the buffer-based text check ALONE decides, because
  //     the leading bytes are sniffed over SFTP with isProbablyTextBuffer. No
  //     extension whitelist is applied: on a remote host a text file often has
  //     no extension or one the shared maps do not list (Makefile, .gitignore,
  //     .bashrc, README, ...), and the byte sniff already rejects binaries.
  ipcMain.handle('axle:canEditFile', async (_e, filePath: string, modelName?: string) => {
    let remoteKey = '';
    try {
      if (!filePath) {
        return { editable: false, reason: 'No file selected' };
      }
      const parsed = parsePath(filePath);

      // Remote (ssh://) file: the check runs over SFTP. On a remote host a text
      // file frequently has NO extension or one the shared whitelist does not
      // list (Makefile, .gitignore, .bashrc, README, config templates, ...), so
      // requiring whitelist membership made ordinary text files uneditable in
      // remote working dirs. The buffer-based text check is authoritative
      // instead: the leading bytes are sniffed THROUGH the connection with the
      // same isProbablyTextBuffer helper the local path uses, so every text
      // file is editable and every binary file is still refused.
      if (parsed.kind === 'remote') {
        const resolved = resolveRemoteTarget(parsed.serverName, modelName);
        if (resolved.error || !resolved.target || !resolved.key) {
          return { editable: false, reason: resolved.error || 'Unknown remote server' };
        }
        remoteKey = resolved.key;

        const remoteExt = path.posix.extname(parsed.path).toLowerCase();
        const remoteWhitelisted = Boolean(
          CODE_EXTENSION_LANGUAGE_MAP[remoteExt] ||
          TEXT_EXTENSION_MIME_MAP[remoteExt] ||
          PURE_TEXT_EXTENSION_MIME_MAP[remoteExt]
        );
        if (remoteWhitelisted) {
          return { editable: true, reason: ''};
        }

        const sftp = await getRemoteSftp(resolved.target, resolved.key);
        const head = await sftpReadHead(sftp, parsed.path, REMOTE_SNIFF_BYTES);
        if (isProbablyTextBuffer(head)) {
          return { editable: true, reason: '' };
        }
        return { editable: false, reason: '' };
      }

      const target = parsed.path;
      if (!fs.statSync(target).isFile()) {
        return { editable: false, reason: 'Not a file' };
      }
      // Extension whitelist: the same maps the read skills use, so anything
      // they treat as code/structured text/pure text is editable here.
      const ext = path.extname(target).toLowerCase();
      const whitelisted = Boolean(
        CODE_EXTENSION_LANGUAGE_MAP[ext] ||
        TEXT_EXTENSION_MIME_MAP[ext] ||
        PURE_TEXT_EXTENSION_MIME_MAP[ext]
      );
      if (whitelisted) {
        return { editable: true, reason: ''}
      }
      // Byte test: an extension alone cannot prove a file is text, so sniff
      // the leading bytes and refuse anything that looks binary.
      if (isProbablyTextFile(target)) {
        return { editable: true, reason: '' };
      }
      return { editable: false, reason: '' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to check file editability:', msg);
      return { editable: false, reason: msg };
    }
  });

  // Read a file as RAW text for the editor dialog. This deliberately does NOT
  // use the shared readFile()/readTextFile() helpers: those wrap code files in
  // a markdown code fence (and render CSV/TSV as a table), which must never be
  // loaded into an editable buffer.
  ipcMain.handle('axle:readFileRaw', async (_e, filePath: string, modelName?: string) => {
    let remoteKey = '';
    try {
      if (!filePath) {
        return { ok: false, error: 'No file selected' };
      }
      const parsed = parsePath(filePath);

      // Remote (ssh://) file: fetch the bytes over SFTP and decode them as
      // utf-8. The content is returned RAW (no code fence) so it can be edited.
      if (parsed.kind === 'remote') {
        const resolved = resolveRemoteTarget(parsed.serverName, modelName);
        if (resolved.error || !resolved.target || !resolved.key) {
          return { ok: false, error: resolved.error || 'Unknown remote server' };
        }
        remoteKey = resolved.key;
        const sftp = await getRemoteSftp(resolved.target, resolved.key);
        const buffer = await sftpReadFileBuffer(sftp, parsed.path);
        return { ok: true, content: buffer.toString('utf-8') };
      }

      const content = fs.readFileSync(parsed.path, 'utf-8');
      return { ok: true, content };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to read file:', msg);
      return { ok: false, error: msg };
    }
  });

  // Write the edited text back to the file. The directory watcher the 'Files'
  // tab opened fires on this change, so the listing refreshes by itself and no
  // explicit refresh is needed here.
  ipcMain.handle('axle:writeFileRaw', async (_e, filePath: string, content: string, modelName?: string) => {
    let remoteKey = '';
    try {
      if (!filePath) {
        return { ok: false, error: 'No file selected' };
      }
      const parsed = parsePath(filePath);

      // Remote (ssh://) file: persist the edited text over SFTP. The session is
      // the cached one, so a save does not open a new SSH connection.
      if (parsed.kind === 'remote') {
        const resolved = resolveRemoteTarget(parsed.serverName, modelName);
        if (resolved.error || !resolved.target || !resolved.key) {
          return { ok: false, error: resolved.error || 'Unknown remote server' };
        }
        remoteKey = resolved.key;
        const sftp = await getRemoteSftp(resolved.target, resolved.key);
        await sftpWriteFile(sftp, parsed.path, content ?? '');
        return { ok: true };
      }

      fs.writeFileSync(parsed.path, content ?? '', 'utf-8');
      return { ok: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to write file:', msg);
      return { ok: false, error: msg };
    }
  });

  // ---- File actions for the right-dock 'Files' tab ----
  //
  // The four channels below implement the New File / New Folder / Copy File /
  // Delete buttons in the Files tab toolbar. LOCAL paths are handled with fs;
  // ssh:// paths go through the CACHED SFTP session (getRemoteSftp ->
  // getSshConn), so none of them opens a new SSH connection: repeated clicks
  // reuse the very same cached connection the listing and the editor use.
  //
  // Every handler resolves { ok, error? } and never throws, so the renderer can
  // surface the message with window.alert. Names are validated HERE as well as
  // in the renderer, so a typed name can never escape its parent directory.

  /** True when `name` is a bare file/folder name (no separators, no dot-dirs). */
  function isPlainEntryName(name: string): boolean {
    if (!name) return false;
    if (name === '.' || name === '..') return false;
    if (name.indexOf('/') >= 0) return false;
    if (name.indexOf('\\') >= 0) return false;
    return true;
  }

  /** Join a NAME onto a REMOTE directory (Linux-like: '/' separator only). */
  function joinRemoteEntry(dir: string, name: string): string {
    const base = (dir || '').replace(/\/+$/, '');
    return base + '/' + name;
  }

  /** Resolve with the SFTP stat of `remotePath`, or null when it is missing. */
  function sftpTryStat(sftp: any, remotePath: string): Promise<any | null> {
    return new Promise<any | null>((resolve) => {
      sftp.stat(remotePath, (err: any, stats: any) => resolve(err ? null : stats));
    });
  }

  /** Promisified SFTP mkdir: NON-recursive, so an existing folder is an error. */
  function sftpMkdirStrict(sftp: any, remotePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err: any) => (err ? reject(err) : resolve()));
    });
  }

  /** Promisified SFTP unlink (removes a FILE). */
  function sftpUnlink(sftp: any, remotePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.unlink(remotePath, (err: any) => (err ? reject(err) : resolve()));
    });
  }

  /** Promisified SFTP rmdir (removes an EMPTY directory). */
  function sftpRmdir(sftp: any, remotePath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.rmdir(remotePath, (err: any) => (err ? reject(err) : resolve()));
    });
  }

  /** Promisified SFTP readdir. Entries carry `filename` and `attrs`. */
  function sftpReaddir(sftp: any, remotePath: string): Promise<any[]> {
    return new Promise<any[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err: any, list: any[]) => (err ? reject(err) : resolve(list || [])));
    });
  }

  /** True when a readdir entry is a directory (attrs first, longname second). */
  function remoteEntryIsDir(entry: any): boolean {
    try {
      if (entry && entry.attrs && typeof entry.attrs.isDirectory === 'function') {
        return entry.attrs.isDirectory();
      }
    } catch {
      /* fall through to the longname test */
    }
    return typeof entry?.longname === 'string' && entry.longname.startsWith('d');
  }

  /** Read a whole remote file as a Buffer (used by the copy handler). */
  function sftpReadBuffer(sftp: any, remotePath: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(remotePath, (err: any, data: Buffer) => (err ? reject(err) : resolve(data)));
    });
  }

  /** Write a Buffer to a remote file (used by the copy handler). */
  function sftpWriteBuffer(sftp: any, remotePath: string, data: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      sftp.writeFile(remotePath, data, (err: any) => (err ? reject(err) : resolve()));
    });
  }

  /** Depth-first removal of a REMOTE directory tree (files, then the folder). */
  async function removeRemoteTree(sftp: any, remotePath: string): Promise<void> {
    const entries = await sftpReaddir(sftp, remotePath);
    for (const entry of entries) {
      const name = String(entry?.filename ?? '');
      if (!name || name === '.' || name === '..') continue;
      const child = joinRemoteEntry(remotePath, name);
      if (remoteEntryIsDir(entry)) {
        await removeRemoteTree(sftp, child);
      } else {
        await sftpUnlink(sftp, child);
      }
    }
    await sftpRmdir(sftp, remotePath);
  }

  /** Resolve an ssh:// path to its SSH target, or to a ready error message. */
  function resolveEntryTarget(
    parsed: any,
    modelName?: string
  ): { target?: SshTarget; key?: string; error?: string } {
    const resolved = resolveRemoteTarget(parsed.serverName, modelName);
    if (resolved.error || !resolved.target || !resolved.key) {
      return { error: resolved.error || 'Unknown remote server' };
    }
    return { target: resolved.target, key: resolved.key };
  }

  /** Create an EMPTY file. An existing file is never truncated. */
  ipcMain.handle('axle:createFile', async (_e, filePath: string, modelName?: string) => {
    let remoteKey = '';
    try {
      if (!filePath) {
        return { ok: false, error: 'No file selected' };
      }
      const parsed = parsePath(filePath);
      const name =
        parsed.kind === 'remote' ? path.posix.basename(parsed.path) : path.basename(parsed.path);
      if (!isPlainEntryName(name)) {
        return { ok: false, error: 'Invalid file name.' };
      }

      if (parsed.kind === 'remote') {
        const t = resolveEntryTarget(parsed, modelName);
        if (t.error || !t.target || !t.key) {
          return { ok: false, error: t.error || 'Unknown remote server' };
        }
        remoteKey = t.key;
        const sftp = await getRemoteSftp(t.target, t.key);
        // sftpWriteFile would silently truncate, so refuse an existing entry.
        if (await sftpTryStat(sftp, parsed.path)) {
          return { ok: false, error: 'A file or folder named "' + name + '" already exists.' };
        }
        await sftpWriteBuffer(sftp, parsed.path, Buffer.from('', 'utf-8'));
        return { ok: true };
      }

      // LOCAL: the 'wx' flag creates the file only when it does not exist yet.
      fs.writeFileSync(parsed.path, '', { encoding: 'utf-8', flag: 'wx' });
      return { ok: true };
    } catch (error) {
      if (remoteKey) dropRemoteSftp(remoteKey);
      if ((error as any)?.code === 'EEXIST') {
        return { ok: false, error: 'A file or folder with that name already exists.' };
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to create file:', msg);
      return { ok: false, error: msg };
    }
  });

  /** Create a folder. Not recursive: an existing folder is refused. */
  ipcMain.handle('axle:createFolder', async (_e, dirPath: string, modelName?: string) => {
    let remoteKey = '';
    try {
      if (!dirPath) {
        return { ok: false, error: 'No folder selected' };
      }
      const parsed = parsePath(dirPath);
      const name =
        parsed.kind === 'remote' ? path.posix.basename(parsed.path) : path.basename(parsed.path);
      if (!isPlainEntryName(name)) {
        return { ok: false, error: 'Invalid folder name.' };
      }

      if (parsed.kind === 'remote') {
        const t = resolveEntryTarget(parsed, modelName);
        if (t.error || !t.target || !t.key) {
          return { ok: false, error: t.error || 'Unknown remote server' };
        }
        remoteKey = t.key;
        const sftp = await getRemoteSftp(t.target, t.key);
        // sftpMkdir (the recursive helper) ignores errors, so it cannot report
        // a clash; stat first and use the strict, non-recursive mkdir.
        if (await sftpTryStat(sftp, parsed.path)) {
          return { ok: false, error: 'A file or folder named "' + name + '" already exists.' };
        }
        await sftpMkdirStrict(sftp, parsed.path);
        return { ok: true };
      }

      fs.mkdirSync(parsed.path);
      return { ok: true };
    } catch (error) {
      if (remoteKey) dropRemoteSftp(remoteKey);
      if ((error as any)?.code === 'EEXIST') {
        return { ok: false, error: 'A file or folder with that name already exists.' };
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to create folder:', msg);
      return { ok: false, error: msg };
    }
  });

  /** Copy a FILE (folders are refused). An existing destination is refused. */
  ipcMain.handle('axle:copyFile', async (_e, srcPath: string, destPath: string, modelName?: string) => {
    let remoteKey = '';
    try {
      if (!srcPath || !destPath) {
        return { ok: false, error: 'No source or destination given' };
      }
      const src = parsePath(srcPath);
      const dest = parsePath(destPath);

      // Copying stays inside one world: local -> local, or remote -> remote on
      // the SAME server. A cross-world copy is refused rather than silently
      // transferring bytes over a connection the user did not ask for.
      if (src.kind !== dest.kind) {
        return {
          ok: false,
          error: 'Copying between a local folder and a remote server is not supported.'
        };
      }

      if (src.kind === 'remote') {
        if (src.serverName !== dest.serverName) {
          return { ok: false, error: 'Copying between two remote servers is not supported.' };
        }
        const t = resolveEntryTarget(src, modelName);
        if (t.error || !t.target || !t.key) {
          return { ok: false, error: t.error || 'Unknown remote server' };
        }
        remoteKey = t.key;
        const sftp = await getRemoteSftp(t.target, t.key);

        const srcStat = await sftpTryStat(sftp, src.path);
        if (!srcStat) {
          return { ok: false, error: 'The file to copy no longer exists.' };
        }
        if (typeof srcStat.isDirectory === 'function' && srcStat.isDirectory()) {
          return { ok: false, error: 'Only files can be copied.' };
        }
        if (await sftpTryStat(sftp, dest.path)) {
          return { ok: false, error: 'A file or folder with that name already exists.' };
        }

        const buffer = await sftpReadBuffer(sftp, src.path);
        await sftpWriteBuffer(sftp, dest.path, buffer);
        return { ok: true };
      }

      // LOCAL copy: refuse folders and never overwrite an existing entry.
      const stats = fs.statSync(src.path);
      if (stats.isDirectory()) {
        return { ok: false, error: 'Only files can be copied.' };
      }
      if (fs.existsSync(dest.path)) {
        return { ok: false, error: 'A file or folder with that name already exists.' };
      }
      fs.copyFileSync(src.path, dest.path);
      return { ok: true };
    } catch (error) {
      if (remoteKey) dropRemoteSftp(remoteKey);
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to copy file:', msg);
      return { ok: false, error: msg };
    }
  });

  /**
   * First free name for a paste, derived from `name`: the name itself when it is
   * free, otherwise 'stem copy.ext', 'stem copy 2.ext', ... The `exists` probe is
   * async so a REMOTE destination can be checked over SFTP without a second code
   * path.
   */
  async function uniqueEntryName(
    name: string,
    exists: (candidate: string) => Promise<boolean>
  ): Promise<string> {
    if (!(await exists(name))) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = stem + ' copy' + ext;
    let n = 2;
    while (await exists(candidate)) {
      candidate = stem + ' copy ' + n + ext;
      n += 1;
    }
    return candidate;
  }

  /** Recursive REMOTE -> REMOTE copy on ONE cached SFTP session. */
  async function copyRemoteTree(sftp: any, src: string, dest: string): Promise<void> {
    const stats = await sftpTryStat(sftp, src);
    if (stats && typeof stats.isDirectory === 'function' && stats.isDirectory()) {
      await sftpMkdirStrict(sftp, dest);
      const entries = await sftpReaddir(sftp, src);
      for (const entry of entries) {
        const childName = String(entry?.filename ?? '');
        if (!childName || childName === '.' || childName === '..') continue;
        await copyRemoteTree(
          sftp,
          joinRemoteEntry(src, childName),
          joinRemoteEntry(dest, childName)
        );
      }
      return;
    }
    const buffer = await sftpReadBuffer(sftp, src);
    await sftpWriteBuffer(sftp, dest, buffer);
  }

  /** Recursive REMOTE -> LOCAL copy (files are written with fs). */
  async function copyRemoteTreeToLocal(sftp: any, src: string, dest: string): Promise<void> {
    const stats = await sftpTryStat(sftp, src);
    if (stats && typeof stats.isDirectory === 'function' && stats.isDirectory()) {
      fs.mkdirSync(dest);
      const entries = await sftpReaddir(sftp, src);
      for (const entry of entries) {
        const childName = String(entry?.filename ?? '');
        if (!childName || childName === '.' || childName === '..') continue;
        await copyRemoteTreeToLocal(
          sftp,
          joinRemoteEntry(src, childName),
          path.join(dest, childName)
        );
      }
      return;
    }
    fs.writeFileSync(dest, await sftpReadBuffer(sftp, src));
  }

  /** Recursive LOCAL -> REMOTE copy (folders are created over SFTP). */
  async function copyLocalTreeToRemote(sftp: any, src: string, dest: string): Promise<void> {
    const stats = fs.statSync(src);
    if (stats.isDirectory()) {
      await sftpMkdirStrict(sftp, dest);
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        await copyLocalTreeToRemote(
          sftp,
          path.join(src, entry.name),
          joinRemoteEntry(dest, entry.name)
        );
      }
      return;
    }
    await sftpWriteBuffer(sftp, dest, fs.readFileSync(src));
  }

  /**
   * Copy a file OR a folder, recursively, for the 'Files' tab's Paste action.
   * Unlike axle:copyFile this accepts folders and EVERY world combination:
   * local -> local, remote -> remote on the same server, local -> remote and
   * remote -> local. The destination is auto-renamed ('name copy', 'name copy
   * 2', ...) so an existing entry is never overwritten, and the final path is
   * returned in `path` so the renderer can tell the user what was created.
   */
  ipcMain.handle('axle:copyEntry', async (_e, srcPath: string, destPath: string, modelName?: string) => {
    const remoteKeys: string[] = [];
    try {
      if (!srcPath || !destPath) {
        return { ok: false, error: 'No source or destination given' };
      }
      const src = parsePath(srcPath);
      const dest = parsePath(destPath);

      // Two DIFFERENT remote hosts cannot be bridged implicitly.
      if (src.kind === 'remote' && dest.kind === 'remote' && src.serverName !== dest.serverName) {
        return { ok: false, error: 'Copying between two remote servers is not supported.' };
      }

      // A folder can never be pasted inside itself or inside its own subtree.
      const flat = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (flat(dest.path).startsWith(flat(src.path) + '/')) {
        return { ok: false, error: 'A folder cannot be pasted inside itself.' };
      }

      // The source must exist before any connection is opened for the target.
      let srcIsDir = false;
      let srcSftp: any = null;
      if (src.kind === 'remote') {
        const t = resolveEntryTarget(src, modelName);
        if (t.error || !t.target || !t.key) {
          return { ok: false, error: t.error || 'Unknown remote server' };
        }
        remoteKeys.push(t.key);
        srcSftp = await getRemoteSftp(t.target, t.key);
        const stats = await sftpTryStat(srcSftp, src.path);
        if (!stats) {
          return { ok: false, error: 'The item to copy no longer exists.' };
        }
        srcIsDir = typeof stats.isDirectory === 'function' && stats.isDirectory();
      } else {
        if (!fs.existsSync(src.path)) {
          return { ok: false, error: 'The item to copy no longer exists.' };
        }
        srcIsDir = fs.statSync(src.path).isDirectory();
      }

      // Destination session: the SAME cached one when both ends are remote.
      let destSftp: any = null;
      if (dest.kind === 'remote') {
        if (srcSftp) {
          destSftp = srcSftp;
        } else {
          const t = resolveEntryTarget(dest, modelName);
          if (t.error || !t.target || !t.key) {
            return { ok: false, error: t.error || 'Unknown remote server' };
          }
          remoteKeys.push(t.key);
          destSftp = await getRemoteSftp(t.target, t.key);
        }
      }

      // Split the requested destination into its directory and entry name.
      const destDir =
        dest.kind === 'remote' ? path.posix.dirname(dest.path) : path.dirname(dest.path);
      const wantedName =
        dest.kind === 'remote' ? path.posix.basename(dest.path) : path.basename(dest.path);
      if (!wantedName || wantedName === '.' || wantedName === '..') {
        return { ok: false, error: 'Invalid destination name.' };
      }

      const exists = async (candidate: string): Promise<boolean> => {
        if (dest.kind === 'remote') {
          return Boolean(await sftpTryStat(destSftp, joinRemoteEntry(destDir, candidate)));
        }
        return fs.existsSync(path.join(destDir, candidate));
      };
      const finalName = await uniqueEntryName(wantedName, exists);
      const finalPath =
        dest.kind === 'remote' ? joinRemoteEntry(destDir, finalName) : path.join(destDir, finalName);

      if (src.kind === 'local' && dest.kind === 'local') {
        if (srcIsDir) {
          fs.cpSync(src.path, finalPath, { recursive: true, errorOnExist: true, force: false });
        } else {
          fs.copyFileSync(src.path, finalPath);
        }
      } else if (src.kind === 'remote' && dest.kind === 'remote') {
        await copyRemoteTree(srcSftp, src.path, finalPath);
      } else if (src.kind === 'remote') {
        await copyRemoteTreeToLocal(srcSftp, src.path, finalPath);
      } else {
        await copyLocalTreeToRemote(destSftp, src.path, finalPath);
      }

      return {
        ok: true,
        path: dest.kind === 'remote' ? 'ssh://' + (dest.serverName || '') + finalPath : finalPath
      };
    } catch (error) {
      for (const key of remoteKeys) dropRemoteSftp(key);
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to copy entry:', msg);
      return { ok: false, error: msg };
    }
  });

  /** Delete a file, or a folder together with everything inside it. */
  ipcMain.handle('axle:deleteEntry', async (_e, targetPath: string, modelName?: string) => {
    let remoteKey = '';
    try {
      if (!targetPath) {
        return { ok: false, error: 'Nothing selected' };
      }
      const parsed = parsePath(targetPath);

      if (parsed.kind === 'remote') {
        const t = resolveEntryTarget(parsed, modelName);
        if (t.error || !t.target || !t.key) {
          return { ok: false, error: t.error || 'Unknown remote server' };
        }
        remoteKey = t.key;
        const sftp = await getRemoteSftp(t.target, t.key);

        const stats = await sftpTryStat(sftp, parsed.path);
        if (!stats) {
          return { ok: false, error: 'That entry no longer exists.' };
        }
        if (typeof stats.isDirectory === 'function' && stats.isDirectory()) {
          await removeRemoteTree(sftp, parsed.path);
        } else {
          await sftpUnlink(sftp, parsed.path);
        }
        return { ok: true };
      }

      const stats = fs.statSync(parsed.path);
      if (stats.isDirectory()) {
        fs.rmSync(parsed.path, { recursive: true, force: false });
      } else {
        fs.unlinkSync(parsed.path);
      }
      return { ok: true };
    } catch (error) {
      if (remoteKey) dropRemoteSftp(remoteKey);
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to delete entry:', msg);
      return { ok: false, error: msg };
    }
  });

  // ---- System (OS) clipboard for FILES ----
  //
  // The Files tab's Copy/Paste prefer the OPERATING SYSTEM clipboard for LOCAL
  // entries, so a file copied in the app can be pasted into Explorer/Finder and
  // a file copied there can be pasted into the app. Windows carries the list in
  // CF_HDROP: a DROPFILES header followed by a double-null-terminated list of
  // paths. Other platforms are served best-effort through a file URI list.
  // Remote (ssh://) paths have no OS representation, so they are filtered out on
  // BOTH sides and keep using the renderer's in-memory clipboard.

  /** Offset of the path list inside a Windows DROPFILES structure. */
  const DROPFILES_HEADER_SIZE = 20;

  /** Build a Windows CF_HDROP buffer: DROPFILES header + UTF-16LE path list. */
  function buildDropFiles(filePaths: string[]): Buffer {
    const header = Buffer.alloc(DROPFILES_HEADER_SIZE);
    // pFiles: byte offset where the path list begins, directly after the header.
    header.writeUInt32LE(DROPFILES_HEADER_SIZE, 0);
    // pt.x / pt.y: the drop point, unused when pasting.
    header.writeInt32LE(0, 4);
    header.writeInt32LE(0, 8);
    // fNC: not a non-client-area drop.
    header.writeInt32LE(0, 12);
    // fWide: TRUE, so the list is UTF-16LE rather than ANSI.
    header.writeInt32LE(1, 16);

    const parts: Buffer[] = [header];
    for (const filePath of filePaths) {
      parts.push(Buffer.from(filePath + '\u0000', 'utf16le'));
    }
    // The list itself ends with one extra null terminator.
    parts.push(Buffer.from('\u0000', 'utf16le'));
    return Buffer.concat(parts);
  }

  /** Parse a Windows CF_HDROP buffer into its paths. Malformed data yields []. */
  function parseDropFiles(buf: Buffer): string[] {
    const files: string[] = [];
    try {
      if (!buf || buf.length <= DROPFILES_HEADER_SIZE) return files;
      const pFiles = buf.readUInt32LE(0);
      const wide = buf.readInt32LE(16) !== 0;
      if (pFiles < DROPFILES_HEADER_SIZE || pFiles >= buf.length) return files;

      let offset = pFiles;
      let current = '';
      if (wide) {
        while (offset + 1 < buf.length) {
          const code = buf.readUInt16LE(offset);
          offset += 2;
          if (code === 0) {
            // An empty entry marks the end of the list.
            if (!current) break;
            files.push(current);
            current = '';
          } else {
            current += String.fromCharCode(code);
          }
        }
      } else {
        while (offset < buf.length) {
          const byte = buf[offset];
          offset += 1;
          if (byte === 0) {
            if (!current) break;
            files.push(current);
            current = '';
          } else {
            current += String.fromCharCode(byte);
          }
        }
      }
    } catch {
      /* Malformed clipboard payload: report nothing rather than throwing. */
    }
    return files;
  }

  /** 'file:///C:/a/b.txt' -> 'C:\\a\\b.txt' (POSIX paths keep their leading '/'). */
  function decodeClipboardUri(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    if (!/^file:\/\//i.test(trimmed)) {
      // Some desktops put a bare absolute path in the text formats.
      return path.isAbsolute(trimmed) ? trimmed : null;
    }
    let rest = trimmed.replace(/^file:\/\//i, '');
    // A 'localhost' authority carries no meaning for a local file.
    if (/^localhost\//i.test(rest)) rest = rest.slice('localhost'.length);
    let decoded = rest;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      decoded = rest;
    }
    // Windows URLs look like '/C:/dir/file'; drop the leading slash.
    if (/^\/[a-zA-Z]:\//.test(decoded)) {
      return decoded.slice(1).replace(/\//g, '\\');
    }
    return decoded.startsWith('/') ? decoded : '/' + decoded;
  }

  /**
   * MIME type used by this Electron version to address a RAW system clipboard
   * format (documented on Clipboard.has): CF_HDROP and friends live here.
   */
  function osClipboardFormatMime(format: string): string {
    return 'electron application/osclipboard;format="' + format + '"';
  }

  /**
   * Read a raw clipboard format as bytes, or null when it is absent.
   *
   * This Electron release exposes only the modern async Clipboard API (has /
   * read / readText / write / writeText); the synchronous readBuffer/
   * writeBuffer pair is gone. Raw formats are therefore addressed through the
   * custom MIME above and their payload comes back as a Blob.
   */
  async function readRawClipboardFormat(format: string): Promise<Buffer | null> {
    try {
      const mime = osClipboardFormatMime(format);
      if (!(await clipboard.has(mime))) return null;
      const items = await clipboard.read();
      for (const item of items) {
        const entry = item as unknown as {
          types?: string[];
          getType?: (type: string) => Promise<unknown>;
        };
        if (!entry || !Array.isArray(entry.types) || entry.types.indexOf(mime) < 0) continue;
        if (typeof entry.getType !== 'function') continue;
        const payload = await entry.getType(mime);
        const blob = payload as { arrayBuffer?: () => Promise<ArrayBuffer> };
        if (blob && typeof blob.arrayBuffer === 'function') {
          return Buffer.from(await blob.arrayBuffer());
        }
        if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Local paths currently on the OS clipboard (remote paths are dropped). */
  async function readClipboardFileList(): Promise<string[]> {
    const keepLocal = (list: string[]): string[] => {
      const out: string[] = [];
      for (const raw of list) {
        if (typeof raw !== 'string') continue;
        // Clipboard payloads are not always bare paths: Explorer/file managers
        // quote the text representation ("C:\\dir\\file.txt"), the wide
        // formats keep their NUL padding, some desktops prefix file://, and a
        // copied folder keeps a trailing separator. Paste derives the PASTED
        // FILE NAME from this path's basename, so any of those would end up in
        // the name ('file.txt"'). Every platform and format funnels through
        // here, so the path is cleaned once, at the source.
        const candidate = raw
          .replace(/\u0000+$/, '')
          .trim()
          .replace(/^"([\s\S]*)"$/, '$1')
          .trim()
          .replace(/^file:\/\/(?:localhost)?/i, '');
        if (!candidate) continue;
        try {
          if (parsePath(candidate).kind === 'remote') continue;
        } catch {
          continue;
        }
        if (!out.includes(candidate)) out.push(candidate);
      }
      return out;
    };

    try {
      if (process.platform === 'win32') {
        const dropBuffer = await readRawClipboardFormat('CF_HDROP');
        if (dropBuffer) {
          const dropped = parseDropFiles(dropBuffer);
          if (dropped.length) return keepLocal(dropped);
        }

        // A single-file copy (some dialogs) exposes only the name formats.
        const wide = await readRawClipboardFormat('FileNameW');
        if (wide && wide.length) {
          const text = wide.toString('utf16le').replace(/\u0000+$/, '');
          if (text) return keepLocal([text]);
        }
        const ansi = await readRawClipboardFormat('FileName');
        if (ansi && ansi.length) {
          const text = ansi.toString('latin1').replace(/\u0000+$/, '');
          if (text) return keepLocal([text]);
        }
        return [];
      }

      // POSIX: the plain-text payload holds either file URIs (one per line) or
      // absolute paths. Both forms are decoded; a candidate only counts when it
      // really exists, so unrelated text (a web URL, a sentence) is ignored.
      const text = await clipboard.readText();
      if (!text || text.length > 8192) return [];
      const fromText: string[] = [];
      for (const line of text.split(/\r?\n/)) {
        const decoded = decodeClipboardUri(line);
        if (!decoded) continue;
        try {
          if (!fs.existsSync(decoded)) continue;
        } catch {
          continue;
        }
        fromText.push(decoded);
      }
      return keepLocal(fromText);
    } catch {
      return [];
    }
  }

  /**
   * Report the LOCAL files currently on the OS clipboard so the Files tab can
   * enable Paste and copy them into the directory on screen.
   */
  ipcMain.handle('axle:getClipboardFiles', async () => {
    try {
      return { ok: true, files: await readClipboardFileList() };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, files: [] as string[], error: msg };
    }
  });

  /**
   * Put LOCAL files on the OS clipboard so the Files tab's Copy can be pasted in
   * another application (Explorer/Finder/file manager) and so the same data
   * survives a restart. Remote paths are refused: they have no OS form.
   */
  ipcMain.handle('axle:setClipboardFiles', async (_e, paths: string[]) => {
    try {
      const list = Array.isArray(paths) ? paths : [];
      const locals: string[] = [];
      for (const candidate of list) {
        if (typeof candidate !== 'string' || !candidate) continue;
        const parsed = parsePath(candidate);
        if (parsed.kind === 'remote') continue;
        let exists = false;
        try {
          exists = fs.existsSync(parsed.path);
        } catch {
          exists = false;
        }
        if (!exists) continue;
        if (!locals.includes(parsed.path)) locals.push(parsed.path);
      }
      if (locals.length === 0) {
        return { ok: false, error: 'Only local files can be placed on the system clipboard.' };
      }

      // Build the file URI list once: it is the representation other applications
      // understand best (Explorer/Finder/file managers), and the plain path list
      // doubles as a readable fallback for anything that only reads text.
      const uris = locals.map((localPath) => {
        const slashed = localPath.replace(/\\/g, '/');
        const rooted = /^[a-zA-Z]:\//.test(slashed) || slashed.startsWith('/') ? slashed : '/' + slashed;
        const encoded = rooted
          .split('/')
          // The drive letter (or the leading empty segment of a POSIX path) is
          // left as-is; every other segment is percent-encoded.
          .map((segment, index) => (index <= 1 && /^([a-zA-Z]:)?$/.test(segment) ? segment : encodeURIComponent(segment)))
          .join('/');
        return 'file://' + encoded;
      });
      const uriList = uris.join('\r\n') + '\r\n';
      const plainList = locals.join('\r\n');

      // ONE write commits every representation atomically. The raw CF_HDROP
      // blob (Windows only) is what Explorer actually pastes; the two text
      // formats are what this app's own reader can parse, and they are the only
      // channel available on platforms without a raw-format mapping.
      try {
        const payload: Record<string, string | Blob> = {
          'text/uri-list': uriList,
          'text/plain': plainList
        };
        if (process.platform === 'win32') {
          const BlobCtor = (globalThis as unknown as {
            Blob?: new (parts: unknown[], options?: { type?: string }) => Blob;
          }).Blob;
          if (BlobCtor) {
            const dropMime = osClipboardFormatMime('CF_HDROP');
            payload[dropMime] = new BlobCtor([buildDropFiles(locals)], { type: dropMime });
          }
        }
        await clipboard.write([new ClipboardItem(payload)]);
        return { ok: true };
      } catch {
        // The rich write was refused: plain text still carries the same paths,
        // so this app (and any text consumer) can paste them.
        await clipboard.writeText(plainList);
        return { ok: true };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to set the file clipboard:', msg);
      return { ok: false, error: msg };
    }
  });

  // ---- Persist a 'persistable' chat message as a prompt/skill file ----
  //
  // The renderer's chat log shows hover buttons ('Save' / 'Save as Skill') on
  // messages whose Protocol.signal is 'persistable'. Both open the SAME file
  // name editor used for images and end up here, because the renderer is
  // sandboxed and cannot touch the filesystem.
  //
  //   asSkill = false -> write into the agent's current working directory;
  //   asSkill = true  -> write into `<workingDir>/.axle` (created if missing).
  //
  // LOCAL working dirs are written with fs; ssh:// working dirs are written
  // over the CACHED SFTP session, so saving never opens a new SSH connection.
  // An existing file is never overwritten: the clash is reported back and the
  // renderer keeps the editor open.
  ipcMain.handle(
    'axle:savePromptFile',
    async (
      _e,
      content: string,
      modelName?: string,
      requestedFileName?: string,
      asSkill?: boolean,
      targetDir?: string
    ) => {
      try {
        if (typeof content !== 'string') {
          return { ok: false, error: 'No content provided' };
        }

        // Sanitize the typed name: no directory part, no characters that are
        // illegal on Windows/POSIX, no leading dots, and always a plain name.
        const raw = typeof requestedFileName === 'string' ? requestedFileName.trim() : '';
        if (!raw) {
          return { ok: false, error: 'Please enter a file name.' };
        }
        let fileName = raw.replace(/^.*[\\/]/, '');
        fileName = fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '');
        fileName = fileName.replace(/^\.+/, '').trim();
        if (!fileName) {
          return { ok: false, error: 'Invalid file name.' };
        }

        // Resolve the destination directory: the folder HIGHLIGHTED in the Files
        // tab when the caller supplied one, otherwise the working directory the
        // message belongs to. Both worlds are handled below unchanged, so a
        // highlighted LOCAL folder writes with fs and a highlighted REMOTE folder
        // writes over the cached SFTP session.
        const overrideDir = typeof targetDir === 'string' ? targetDir.trim() : '';
        const workingDirStr = resolveAgent(modelName)?.getCwd() ?? process.cwd();
        const parsed = overrideDir ? parsePath(overrideDir) : parsePath(workingDirStr);

        // 'Save as Skill' targets `<workingDir>/.axle`.
        const isSkill = asSkill === true;

        if (parsed.kind === 'remote') {
          const resolved = resolveRemoteTarget(parsed.serverName, modelName);
          if (resolved.error || !resolved.target || !resolved.key) {
            return { ok: false, error: resolved.error || 'Unknown remote server' };
          }
          const baseDir = (parsed.path || '.').replace(/\/+$/, '');
          const dir = isSkill ? `${baseDir}/.axle` : baseDir;
          const fullPath = `${dir}/${fileName}`;

          const sftp = await getRemoteSftp(resolved.target, resolved.key);
          // Create the target folder (recursively) when it is missing.
          await sftpMkdir(sftp, dir);

          // Refuse to overwrite an existing file.
          if (await remoteFileExists(sftp, fullPath)) {
            return { ok: false, error: '"' + fileName + '" already exists in ' + (isSkill ? 'the .axle folder' : 'the working directory') + '.' };
          }

          await sftpWriteFile(sftp, fullPath, content);
          return { ok: true, path: fullPath, fileName };
        }

        // LOCAL working dir.
        const baseDir = parsed.path;
        const dir = isSkill ? path.join(baseDir, '.axle') : baseDir;
        const fullPath = path.join(dir, fileName);

        // The resolved path must stay INSIDE the target directory.
        if (path.resolve(path.dirname(fullPath)) !== path.resolve(dir)) {
          return { ok: false, error: 'Invalid file name.' };
        }

        // Create the target folder (recursively) when it is missing.
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Refuse to overwrite: a case-insensitive clash with ANY entry in the
        // target directory makes the save fail and nothing is written.
        let clash = false;
        try {
          clash = fs.readdirSync(dir).some((n: string) => n.toLowerCase() === fileName.toLowerCase());
        } catch {
          clash = false;
        }
        if (!clash) {
          try { clash = fs.existsSync(fullPath); } catch { clash = false; }
        }
        if (clash) {
          return { ok: false, error: '"' + fileName + '" already exists in ' + (isSkill ? 'the .axle folder' : 'the working directory') + '.' };
        }

        // 'wx' also covers the race where the file appears just now.
        try {
          fs.writeFileSync(fullPath, content, { encoding: 'utf-8', flag: 'wx' });
        } catch (writeErr) {
          const code = (writeErr as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            return { ok: false, error: '"' + fileName + '" already exists in ' + (isSkill ? 'the .axle folder' : 'the working directory') + '.' };
          }
          throw writeErr;
        }

        return { ok: true, path: fullPath, fileName };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[axle] Failed to save prompt file:', msg);
        return { ok: false, error: msg };
      }
    }
  );

  // ---- Image preview (right-click -> 'View') ----
  //
  // The renderer is sandboxed and must not import the shared helpers either
  // (src/common/common.ts pulls in fs and ssh2), so BOTH the whitelist check
  // and the byte read happen here. The whitelist is the shared
  // IMAGE_EXTENSION_MIME_MAP, so the menu and this handler can never disagree.
  // SVG is allowed explicitly: common.ts classifies it as an XML TEXT format
  // (it appears in TEXT_EXTENSION_MIME_MAP, not in the image map) yet it is an
  // image the user expects to preview.
  const IMAGE_VIEW_EXTRA_EXTENSIONS = new Set<string>(['.svg']);

  // MIME type of a previewable image path ('' when the extension is not an
  // image). Only the extension of the path is inspected, so the check works
  // identically for LOCAL files and ssh:// remote paths.
  const imageMimeTypeFor = (ext: string): string => {
    const meta = IMAGE_EXTENSION_MIME_MAP[ext];
    if (meta) return meta.mimeType;
    if (IMAGE_VIEW_EXTRA_EXTENSIONS.has(ext)) {
      return TEXT_EXTENSION_MIME_MAP[ext] || 'image/svg+xml';
    }
    return '';
  };

  // Report whether a file may be previewed by the 'View' menu item. The
  // decision needs no SSH connection: the extension whitelist alone answers it,
  // so a remote directory can show the enabled/disabled item immediately.
  ipcMain.handle('axle:canViewFile', async (_e, filePath: string, _modelName?: string) => {
    try {
      if (!filePath) {
        return { viewable: false, reason: 'No file selected' };
      }
      const parsed = parsePath(filePath);
      const ext = path.extname(parsed.path).toLowerCase();
      if (!imageMimeTypeFor(ext)) {
        return { viewable: false, reason: 'Not an image file' };
      }
      return { viewable: true, reason: '' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to check file previewability:', msg);
      return { viewable: false, reason: msg };
    }
  });

  // Read an image file and return its bytes as base64 plus its MIME type, so
  // the renderer can build a data: URI and show it in the preview dialog. LOCAL
  // files are read from disk; ssh:// paths are fetched over the cached SFTP
  // session, mirroring the readFileRaw/writeFileRaw handlers above. Only
  // whitelisted image extensions are served, so this channel can never be used
  // to pull arbitrary binary data into the renderer.
  ipcMain.handle('axle:readImageFile', async (_e, filePath: string, modelName?: string) => {
    try {
      if (!filePath) {
        return { ok: false, error: 'No file selected' };
      }
      const parsed = parsePath(filePath);
      const ext = path.extname(parsed.path).toLowerCase();
      const mimeType = imageMimeTypeFor(ext);
      if (!mimeType) {
        return { ok: false, error: 'Not a viewable image file: ' + (ext || '(no extension)') };
      }

      // Remote (ssh://) image: fetch the bytes over SFTP. The session is the
      // cached one, so previewing does not open a new SSH connection.
      if (parsed.kind === 'remote') {
        const resolved = resolveRemoteTarget(parsed.serverName, modelName);
        if (resolved.error || !resolved.target || !resolved.key) {
          return { ok: false, error: resolved.error || 'Unknown remote server' };
        }
        const sftp = await getRemoteSftp(resolved.target, resolved.key);
        const buffer = await sftpReadFileBuffer(sftp, parsed.path);
        return { ok: true, base64: buffer.toString('base64'), mimeType };
      }

      const buffer = fs.readFileSync(parsed.path);
      return { ok: true, base64: buffer.toString('base64'), mimeType };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[axle] Failed to read image file:', msg);
      return { ok: false, error: msg };
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
  // macOS ignores the BrowserWindow `icon` option: the Dock always shows the
  // .app bundle icon. In a packaged build that icon comes from
  // build/app-icon.icns (packagerConfig.icon), but under `npm start` the
  // bundle is Electron's own, so set the Dock icon explicitly to keep dev
  // builds visually consistent with the packaged app.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(getAppIconPath());
    } catch (error) {
      console.warn('[axle] Failed to set the Dock icon:', error);
    }
  }

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

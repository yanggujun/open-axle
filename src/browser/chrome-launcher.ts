// chrome-launcher.ts
//
// Chrome-SPECIFIC process + HTTP mechanics.
//
// This module is the single place that knows how a Chromium-family browser is
// started and how its DevTools HTTP endpoints are discovered. Everything that
// wants to stay browser-agnostic must go through ./browser-factory.ts instead.
//
// It deliberately does NOT speak the DevTools WebSocket protocol: that lives in
// ./chrome.ts (ChromeInterface). Keeping them apart lets the provider compose
// "make sure a browser exists" with "talk to the browser".

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';

/** Default DevTools host when nothing else is specified. */
export const DEFAULT_DEBUG_HOST = '127.0.0.1';

/** Default DevTools port used by Chrome's --remote-debugging-port. */
export const DEFAULT_DEBUG_PORT = 9222;

/** Default time to wait for a freshly launched browser to open its port. */
export const DEFAULT_LAUNCH_TIMEOUT = 20000;

/**
 * Root directory holding the persistent browser profile.
 *
 * Profiles live under the user's home (not the temp directory) so that cookies,
 * logins, history and storage survive across launches: log into a site once and
 * later sessions are still authenticated.
 */
export function profileRootDir(): string {
  return path.join(os.homedir(), '.axle', 'browser-profiles');
}

/**
 * The ONE profile directory used by the automation browser.
 *
 * Deliberately a single shared profile — never one per port and never a
 * throwaway temp directory. Cookies, logins and history therefore live in
 * exactly one place, so every automation session sees the same browser
 * identity instead of accumulating orphaned profiles.
 */
export function defaultProfileDir(): string {
  return path.join(profileRootDir(), 'chrome-' + DEFAULT_DEBUG_PORT);
}

/**
 * A resolved, pinned browser endpoint.
 *
 * The automation browser has exactly one identity: one host, ONE port and ONE
 * profile directory. Everything that needs to reach the browser resolves the
 * endpoint through {@link normalizeEndpoint} so no part of the codebase can
 * accidentally introduce a second profile or a second port.
 */
export interface NormalizedEndpoint {
  host: string;
  port: number;
  userDataDir: string;
}

/**
 * Resolve caller-supplied endpoint options into the single pinned endpoint.
 *
 * A requested `port` other than {@link DEFAULT_DEBUG_PORT} and a requested
 * `userDataDir` other than {@link defaultProfileDir} are IGNORED (with a warning)
 * rather than honored, because honoring them is what produced extra profiles.
 */
export function normalizeEndpoint(
  options: { host?: string; port?: number; userDataDir?: string; } = {}
): NormalizedEndpoint {
  const host = options.host || DEFAULT_DEBUG_HOST;
  const port = DEFAULT_DEBUG_PORT;
  const userDataDir = defaultProfileDir();

  if (options.port !== undefined && options.port !== port) {
    console.warn(
      '[browser] Ignoring requested port ' + options.port +
      '; the automation browser always uses port ' + port + '.'
    );
  }

  if (options.userDataDir && path.resolve(options.userDataDir) !== path.resolve(userDataDir)) {
    console.warn(
      '[browser] Ignoring requested userDataDir "' + options.userDataDir +
      '"; the automation browser always uses ' + userDataDir + '.'
    );
  }

  return { host, port, userDataDir };
}

/**
 * Handle for a browser process started by this module, so it can be shut down
 * again together with the automation session.
 */
export interface LaunchedChrome {
  process: ChildProcess;
  executablePath: string;
  host: string;
  port: number;
  userDataDir: string;
}

/** Result of probing /json/version on a DevTools endpoint. */
export interface DevToolsVersionInfo {
  browser?: string;
  'Protocol-Version'?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: any;
}

/** A raw target entry as advertised by /json/list. */
export interface DevToolsTargetInfo {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: any;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * GET + JSON-parse a DevTools HTTP endpoint.
 *
 * Rejects on connection errors, timeouts and malformed bodies so callers can
 * use it both as a fast liveness probe (catching the rejection) and as a
 * reliable metadata reader.
 */
export function httpGetJson(
  host: string,
  port: number,
  urlPath: string,
  timeoutMs: number = 3000
): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    let settled = false;
    const req = http.get({ host, port, path: urlPath, timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(data));
        } catch (e: any) {
          reject(new Error('Invalid JSON from http://' + host + ':' + port + urlPath + ': ' + e.message));
        }
      });
    });
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error('Timed out after ' + timeoutMs + 'ms probing http://' + host + ':' + port + urlPath));
    });
    req.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Check whether a DevTools endpoint is listening.
 *
 * @returns the /json/version payload, or null when nothing answers.
 */
export async function probeDevTools(
  host: string = DEFAULT_DEBUG_HOST,
  port: number = DEFAULT_DEBUG_PORT,
  timeoutMs: number = 3000
): Promise<DevToolsVersionInfo | null> {
  try {
    const info = await httpGetJson(host, port, '/json/version', timeoutMs);
    if (info && typeof info === 'object') return info as DevToolsVersionInfo;
    return null;
  } catch {
    return null;
  }
}

/** List the debuggable targets of a running browser. */
export async function listDevToolsTargets(
  host: string = DEFAULT_DEBUG_HOST,
  port: number = DEFAULT_DEBUG_PORT,
  timeoutMs: number = 5000
): Promise<DevToolsTargetInfo[]> {
  const raw = await httpGetJson(host, port, '/json/list', timeoutMs);
  if (!Array.isArray(raw)) return [];
  const out: DevToolsTargetInfo[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    out.push(entry as DevToolsTargetInfo);
  }
  return out;
}

/** Candidate Chrome/Chromium/Edge executables for the current platform. */
export function chromeExecutableCandidates(): string[] {
  const platform = process.platform;
  const list: string[] = [];

  if (platform === 'win32') {
    const roots = [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env['LOCALAPPDATA'],
    ];
    for (const root of roots) {
      if (!root) continue;
      list.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      list.push(path.join(root, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'));
      list.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'));
      list.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary');
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    list.push('/usr/bin/google-chrome');
    list.push('/usr/bin/google-chrome-stable');
    list.push('/usr/bin/chromium');
    list.push('/usr/bin/chromium-browser');
    list.push('/snap/bin/chromium');
    list.push('/usr/bin/microsoft-edge');
  }

  return list;
}

/**
 * Resolve a usable browser executable.
 *
 * @param customPath Explicit path to use when it exists.
 * @returns the resolved path, or null when nothing was found.
 */
export function resolveChromeExecutable(customPath?: string): string | null {
  if (customPath) {
    try {
      if (fs.existsSync(customPath)) return customPath;
    } catch { /* ignore */ }
  }
  for (const candidate of chromeExecutableCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return null;
}

/** Options accepted by {@link launchChrome}. */
export interface LaunchChromeOptions {
  host?: string;
  port?: number;
  executablePath?: string;
  userDataDir?: string;
  headless?: boolean;
  startUrl?: string;
  launchTimeout?: number;
}

/**
 * Start a Chromium-family browser with a remote debugging port and wait until
 * the port actually answers.
 *
 * A non-default `--user-data-dir` is mandatory on recent Chrome builds, which
 * otherwise refuse to expose a debugging port.
 *
 * When `userDataDir` is omitted the PERSISTENT per-port profile from
 * {@link defaultProfileDir} is used (not a throwaway temp directory), so
 * cookies and logins survive across launches.
 *
 * @throws when no executable exists or the port never opens in time.
 */
export async function launchChrome(options: LaunchChromeOptions = {}): Promise<LaunchedChrome> {
  // Host/port/profile are pinned: the automation browser always listens on
  // DEFAULT_DEBUG_PORT and always reuses the single persistent profile.
  const endpoint = normalizeEndpoint(options);
  const host = endpoint.host;
  const port = endpoint.port;
  const userDataDir = endpoint.userDataDir;
  const launchTimeout = options.launchTimeout || DEFAULT_LAUNCH_TIMEOUT;

  const executablePath = resolveChromeExecutable(options.executablePath);
  if (!executablePath) {
    throw new Error('Could not locate a Chrome/Chromium executable. Set the executable path explicitly.');
  }

  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch { /* Chrome will surface a real problem */ }

  const args = [
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=' + host,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
  if (options.headless) {
    args.push('--headless=new', '--disable-gpu');
    if (process.platform === 'linux') args.push('--no-sandbox');
  }
  args.push(options.startUrl || 'about:blank');

  const child = spawn(executablePath, args, { detached: false, stdio: 'ignore' });
  child.on('error', () => { /* surfaced by the readiness probe below */ });

  const deadline = Date.now() + launchTimeout;
  let lastError: any = null;
  while (Date.now() < deadline) {
    const info = await probeDevTools(host, port, 2000);
    if (info && info.webSocketDebuggerUrl) {
      return { process: child, executablePath, host, port, userDataDir };
    }
    lastError = info === null ? lastError : null;
    await sleep(300);
  }

  try { child.kill(); } catch { /* ignore */ }
  throw new Error(
    'Browser did not expose a debugging port on ' + host + ':' + port + ' within ' + launchTimeout + 'ms' +
    (lastError ? ' (' + lastError.message + ')' : '') +
    '. Profile directory: ' + userDataDir + '. ' +
    'Common causes: another browser is already using that profile directory ' +
    '(close it, or choose a different port / userDataDir), or the profile directory ' +
    'is in use by a non-debuggable browser instance.'
  );
}

/** Terminate a browser process started by {@link launchChrome}. */
export function terminateChrome(handle: LaunchedChrome | null | undefined): void {
  if (!handle) return;
  try { handle.process.kill(); } catch { /* ignore */ }
}

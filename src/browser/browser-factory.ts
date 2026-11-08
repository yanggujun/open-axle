// browser-factory.ts
//
// The single entry point for obtaining a browser automation interface.
//
// Callers ask for "a browser" — they never construct a concrete browser class
// and never learn which engine backs the interface. The factory keeps a
// registry of BrowserProvider implementations (Chrome is registered by default)
// so additional engines can be plugged in without touching call sites.
//
// Example:
//   const browser = await getBrowserInterface({ mode: 'auto', port: 9222 });
//   await browser.navigate('https://example.com');
//   console.log(await browser.getPageInfo());
//   await closeBrowserInterface(browser);

import {
  BrowserConnectOptions,
  BrowserInterface,
  BrowserKind,
  BrowserLaunchInfo,
  BrowserProvider,
} from './browser-interface';

/** Providers keyed by browser kind. */
const providers = new Map<BrowserKind, BrowserProvider>();

/** Kind requested when the caller does not specify one. */
let defaultKind: BrowserKind = 'chrome';

/** True once the built-in providers have been registered. */
let defaultsRegistered = false;

/** A live session plus the bookkeeping needed to tear it down again. */
interface BrowserSession {
  provider: BrowserProvider;
  browser: BrowserInterface;
  launchInfo: BrowserLaunchInfo;
  options: BrowserConnectOptions;
}

/** Live sessions keyed by "kind@host:port". */
const sessions = new Map<string, BrowserSession>();

function sessionKey(kind: BrowserKind, host: string, port: number): string {
  return kind + '@' + host + ':' + port;
}

/**
 * Register a provider for a browser kind, replacing any previous one.
 *
 * Registering the same kind twice is allowed: the latest provider wins, which
 * lets a host application swap implementations (e.g. tests vs. production).
 */
export function registerBrowserProvider(provider: BrowserProvider): void {
  providers.set(provider.kind, provider);
}

/** Choose which provider is used when no kind is requested. */
export function setDefaultBrowserKind(kind: BrowserKind): void {
  defaultKind = kind;
}

/**
 * Lazily register the built-in providers.
 *
 * The concrete backend is `require`d here (not imported at module top level) so
 * this file stays free of browser-specific dependencies; a bundle that only
 * typechecks never pulls in the CDP implementation.
 */
function registerDefaultProviders(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;

  if (!providers.has('chrome')) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./chrome-provider');
    const provider: BrowserProvider = mod.chromeProvider || new mod.ChromeProvider();
    providers.set(provider.kind, provider);
  }
}

/**
 * Resolve the provider for a browser kind, registering defaults on demand.
 *
 * @throws when no provider is registered for the requested kind.
 */
export function getBrowserProvider(kind?: BrowserKind): BrowserProvider {
  registerDefaultProviders();
  const wanted = kind || defaultKind;
  const provider = providers.get(wanted);
  if (!provider) {
    const known = Array.from(providers.keys()).join(', ') || '(none)';
    throw new Error("No browser provider registered for kind '" + wanted + "'. Registered kinds: " + known + '.');
  }
  return provider;
}

/**
 * Create a browser interface WITHOUT connecting it.
 *
 * Useful when the caller wants to control the connection step itself.
 */
export function createBrowserInterface(
  options: BrowserConnectOptions = {},
  kind?: BrowserKind
): BrowserInterface {
  const provider = getBrowserProvider(kind);
  return provider.create(options);
}

/**
 * Decide whether a cached browser session can be reused.
 *
 * `isConnected()` is only a flag, so when the implementation offers `ping()`
 * the connection is actively verified. A dead socket must never be handed back
 * to a caller — that is what produced "WebSocket is not open: readyState 3".
 *
 * Never throws: any failure means "not alive".
 */
async function isSessionAlive(browser: BrowserInterface): Promise<boolean> {
  if (!browser.isConnected()) {
    return false;
  }
  if (typeof browser.ping !== 'function') {
    return true;
  }
  try {
    return await browser.ping();
  } catch {
    return false;
  }
}

/**
 * Get a connected browser interface.
 *
 * A session already bound to the same kind + endpoint is reused, so repeated
 * calls from a skill invocation drive the same tab instead of opening a new
 * connection each time. The provider decides whether an existing browser is
 * attached to or a new one is launched (see `mode`).
 *
 * @throws when the browser cannot be started, reached or attached to.
 */
export async function getBrowserInterface(
  options: BrowserConnectOptions = {},
  kind?: BrowserKind
): Promise<BrowserInterface> {
  const provider = getBrowserProvider(kind);
  const resolvedKind = kind || defaultKind;

  // Resolve the endpoint BEFORE keying the session: the provider decides the
  // real host/port (implementations may pin them), and a browser that is
  // already running is only probed, never restarted.
  const launchInfo = await provider.ensureRunning(options);
  const key = sessionKey(resolvedKind, launchInfo.host, launchInfo.port);

  const live = sessions.get(key);
  if (live && await isSessionAlive(live.browser)) {
    return live.browser;
  }
  if (live) {
    // The socket died between invocations (tab closed, browser restarted,
    // target swapped by navigation). Discard the session WITHOUT killing the
    // browser: the user's window, tabs and profile must survive, only the
    // stale connection is dropped.
    sessions.delete(key);
    try {
      await closeBrowserInterface(live.browser, false);
    } catch { /* already gone */ }
  }

  // Bind the interface to the endpoint the provider resolved, not to whatever
  // the caller asked for.
  const boundOptions: BrowserConnectOptions = {
    ...options,
    host: launchInfo.host,
    port: launchInfo.port,
  };
  if (launchInfo.profileDir) {
    boundOptions.userDataDir = launchInfo.profileDir;
  }

  const browser = provider.create(boundOptions);

  const connected = await browser.connect(boundOptions);
  if (!connected) {
    throw new Error('Failed to connect to the browser at ' + launchInfo.host + ':' + launchInfo.port + '.');
  }

  sessions.set(key, { provider, browser, launchInfo, options: boundOptions });
  return browser;
}

/**
 * Close a browser interface and forget its session.
 *
 * @param browser  The interface to close. When omitted, every session is closed.
 * @param killProcess  Terminate the browser process too, but ONLY when it was
 *                     started by the factory (an attached browser is never
 *                     killed by mistake).
 */
export async function closeBrowserInterface(
  browser?: BrowserInterface,
  killProcess: boolean = false
): Promise<void> {
  if (!browser) {
    for (const [, session] of Array.from(sessions.entries())) {
      await closeSession(session, killProcess);
    }
    sessions.clear();
    return;
  }

  for (const [key, session] of Array.from(sessions.entries())) {
    if (session.browser === browser) {
      sessions.delete(key);
      await closeSession(session, killProcess);
      return;
    }
  }

  // Not tracked (e.g. created via createBrowserInterface): just close it.
  try { await browser.close(); } catch { /* ignore */ }
}

async function closeSession(session: BrowserSession, killProcess: boolean): Promise<void> {
  try {
    await session.browser.close();
  } catch { /* ignore */ }

  if (!killProcess) return;
  if (!session.provider.ownsProcess) return;
  if (!session.provider.ownsProcess(session.launchInfo)) return;
  if (!session.provider.terminate) return;
  try {
    session.provider.terminate(session.launchInfo);
  } catch { /* ignore */ }
}

/**
 * Close every session and drop the provider registry.
 *
 * Intended for tests and for host shutdown paths; the default providers are
 * registered again on next use.
 */
export async function resetBrowserInterface(): Promise<void> {
  await closeBrowserInterface(undefined, false);
  sessions.clear();
  providers.clear();
  defaultsRegistered = false;
  defaultKind = 'chrome';
}

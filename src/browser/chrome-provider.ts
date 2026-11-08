// chrome-provider.ts
//
// Chrome backend for the browser abstraction.
//
// It adapts the CDP client (.//chrome.ts -> ChromeInterface) and the process
// mechanics (.//chrome-launcher.ts) to the browser-agnostic BrowserProvider
// contract consumed by ./browser-factory.ts.

import {
  BrowserConnectOptions,
  BrowserInterface,
  BrowserKind,
  BrowserLaunchInfo,
  BrowserProvider,
} from './browser-interface';
import { ChromeInterface } from './chrome';
import {
  LaunchedChrome,
  launchChrome,
  normalizeEndpoint,
  probeDevTools,
  terminateChrome,
} from './chrome-launcher';

/** Process handles started by this provider, keyed by host:port. */
const launchedProcesses = new Map<string, LaunchedChrome>();

function endpointKey(host: string, port: number): string {
  return host + ':' + port;
}

/**
 * BrowserProvider for Chrome/Chromium/Edge.
 *
 * `ensureRunning` only starts a process when the connection strategy allows it
 * and no DevTools endpoint answers yet; `create` hands back an unconnected
 * ChromeInterface bound to the requested endpoint.
 */
export class ChromeProvider implements BrowserProvider {
  readonly kind: BrowserKind = 'chrome';

  async ensureRunning(options: BrowserConnectOptions): Promise<BrowserLaunchInfo> {
    // Pinned: one host, one port, one profile. A caller-supplied port or
    // userDataDir is ignored here (normalizeEndpoint warns about it) so no
    // second profile can ever be created.
    const endpoint = normalizeEndpoint(options);
    const host = endpoint.host;
    const port = endpoint.port;
    const mode = options.mode || 'auto';
    const key = endpointKey(host, port);

    const existing = await probeDevTools(host, port, 2000);
    if (existing) {
      return { launched: false, host, port, profileDir: endpoint.userDataDir };
    }

    if (mode === 'attach') {
      throw new Error(
        'No browser DevTools endpoint on ' + host + ':' + port + '. ' +
        'Start the browser with --remote-debugging-port=' + port +
        ' --user-data-dir="' + endpoint.userDataDir + '", ' +
        'or use mode="launch" so a browser is started for you.'
      );
    }

    const handle = await launchChrome({
      host,
      port,
      executablePath: options.executablePath,
      userDataDir: endpoint.userDataDir,
      headless: options.headless,
      startUrl: options.startUrl,
      launchTimeout: options.launchTimeout,
    });

    launchedProcesses.set(key, handle);
    return {
      launched: true,
      executablePath: handle.executablePath,
      // The persistent profile backing this session (logins/cookies live here).
      profileDir: handle.userDataDir,
      host,
      port,
    };
  }

  create(options: BrowserConnectOptions): BrowserInterface {
    return new ChromeInterface(options);
  }

  ownsProcess(info: BrowserLaunchInfo): boolean {
    if (!info.launched) return false;
    return launchedProcesses.has(endpointKey(info.host, info.port));
  }

  terminate(info: BrowserLaunchInfo): void {
    const key = endpointKey(info.host, info.port);
    const handle = launchedProcesses.get(key);
    if (!handle) return;
    launchedProcesses.delete(key);
    terminateChrome(handle);
  }
}

/** Shared singleton provider instance. */
export const chromeProvider = new ChromeProvider();

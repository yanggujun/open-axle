// browser-interface.ts
//
// Browser-AGNOSTIC contracts for agent-driven browser automation.
//
// Everything above the implementation (skills, executors, tooling) programs
// against `BrowserInterface` and never against a concrete browser. The Chrome
// implementation lives in ./chrome.ts and is registered with the factory in
// ./browser-factory.ts; other browsers can be plugged in the same way.

export type BrowserKind = 'chrome' | 'chromium' | 'edge' | (string & {});

/**
 * A debuggable target (usually a browser tab) exposed by the browser.
 */
export interface BrowserTarget {
  /** Browser-assigned target id (stable for the lifetime of the tab). */
  id: string;
  /** Target type, e.g. 'page', 'background_page', 'service_worker'. */
  type: string;
  /** Document title. */
  title: string;
  /** Current URL. */
  url: string;
  /** WebSocket endpoint used to attach to this target, when advertised. */
  webSocketDebuggerUrl?: string;
}

/**
 * Snapshot of the browsing context currently driven by the interface.
 */
export interface PageState {
  url: string;
  title: string;
  readyState: string;
  scrollPosition: { x: number; y: number; };
  viewportSize: { width: number; height: number; };
}

/**
 * Result of a navigation-like operation (navigate / goBack / goForward).
 */
export interface NavigationResult {
  /** Human-readable description of what happened. */
  navigation: string;
  /** Semantic page representation (URL, title, interactive elements, text). */
  pageInfo: string;
  /** Structured page state after the operation. */
  pageState: PageState;
}

/**
 * How the interface should obtain a browser to talk to.
 *
 * - `auto`   : reuse an already-running browser when its debugging endpoint
 *              answers, otherwise start one (first-run friendly default).
 * - `attach` : only ever connect to an already-running browser that already
 *              exposes a debugging port; never start anything.
 * - `launch` : always start a fresh browser process with a debugging port.
 */
export type BrowserConnectionMode = 'auto' | 'attach' | 'launch';

/**
 * Options describing which browser endpoint to use and how to create it.
 *
 * Implementations translate these into their own launch/attach mechanics.
 */
export interface BrowserConnectOptions {
  /** Connection strategy. Defaults to `auto`. */
  mode?: BrowserConnectionMode;
  /** Debugging endpoint host. Defaults to `127.0.0.1`. */
  host?: string;
  /** Debugging endpoint port. Defaults to `9222`. */
  port?: number;
  /** Attach to a specific target id (see {@link BrowserInterface.listTargets}). */
  targetId?: string;
  /** Attach to the first page whose URL contains this substring. */
  targetUrl?: string;
  /** Explicit browser executable path, used when launching. */
  executablePath?: string;
  /**
   * Profile directory for a launched browser.
   *
   * When omitted, implementations use a PERSISTENT default profile rather than
   * a throwaway temp directory, so cookies and logins survive across launches.
   * The Chrome backend stores it under `<home>/.axle/browser-profiles/chrome-<port>`.
   *
   * Point this at the browser's real profile directory at your own risk: recent
   * Chrome builds refuse to open a debugging port on their default profile.
   */
  userDataDir?: string;
  /** Launch without a visible window. */
  headless?: boolean;
  /** Initial URL for a launched browser. */
  startUrl?: string;
  /** Max time to wait for a launched browser to open its debugging port. */
  launchTimeout?: number;
  /** Per-operation timeout hint, in milliseconds. */
  timeout?: number;
}

/**
 * Outcome of making sure a browser process is available.
 */
export interface BrowserLaunchInfo {
  /** True when this call actually started a new browser process. */
  launched: boolean;
  /** Executable path of the launched browser, when it was started here. */
  executablePath?: string;
  /**
   * Profile directory backing this session, when known.
   *
   * Handy for diagnostics and for telling the user where their persistent
   * cookies/logins live.
   */
  profileDir?: string;
  /** Host the debugging endpoint was found/given on. */
  host: string;
  /** Port the debugging endpoint was found/given on. */
  port: number;
}

/**
 * The browser automation surface every implementation must provide.
 *
 * The operation set mirrors the original Chrome DevTools implementation:
 * navigation, mouse/keyboard input, semantic page inspection, script
 * evaluation and history control.
 */
export interface BrowserInterface {
  /** Identifies the concrete browser behind this interface. */
  readonly kind: BrowserKind;

  /** Attach to (or start) a browser and prepare it for automation. */
  connect(options?: BrowserConnectOptions): Promise<boolean>;

  /** True when the interface currently holds a connection. */
  isConnected(): boolean;

  /**
   * Verify the connection is genuinely usable (optional).
   *
   * `isConnected()` is only a flag; a socket can appear open after its target
   * has gone away. Implementations that can prove liveness cheaply should
   * implement this so session reuse never hands back a dead connection.
   *
   * @returns true when the connection provably works, false otherwise. Must not
   *          throw for an unhealthy connection.
   */
  ping?(): Promise<boolean>;

  /** Enumerate the debuggable targets of the connected browser. */
  listTargets(): Promise<BrowserTarget[]>;

  /** Navigate to an absolute URL and wait for the document to settle. */
  navigate(url: string): Promise<NavigationResult>;

  /** Left click at viewport coordinates (CSS pixels). */
  click(x: number, y: number): Promise<void>;

  /** Double click at viewport coordinates (CSS pixels). */
  doubleClick(x: number, y: number): Promise<void>;

  /** Triple click at viewport coordinates (CSS pixels). */
  tripleClick(x: number, y: number): Promise<void>;

  /** Focus the interactive element at `index`. */
  focusElementByIndex(index: number): Promise<void>;

  /** Click the interactive element at `index`. */
  clickElementByIndex(index: number): Promise<void>;

  /**
   * Type text into the focused element.
   *
   * Implementations may support a special-key grammar such as `{Enter}`,
   * `{Tab}` or `{Ctrl+A}`.
   */
  type(text: string): Promise<void>;

  /** `textContent` of the element matching a CSS selector. */
  getElementText(selector: string): Promise<string>;

  /** Semantic page representation (URL, title, interactive elements, text). */
  getPageInfo(): Promise<string>;

  /** Structured page state (url, title, readyState, scroll, viewport). */
  getPageState(): Promise<PageState>;

  /** Navigate one step back in session history. */
  goBack(): Promise<NavigationResult>;

  /** Navigate one step forward in session history. */
  goForward(): Promise<NavigationResult>;

  /** Evaluate a JavaScript expression in the page and return its value. */
  evaluate(expression: string): Promise<any>;

  /** Release the connection (and any process this interface started). */
  close(): Promise<void>;
}

/**
 * A pluggable browser backend.
 *
 * The factory in ./browser-factory.ts keeps a registry of providers, so the
 * rest of the codebase can ask for "a browser" by kind without importing a
 * concrete implementation.
 */
export interface BrowserProvider {
  /** Provider identifier, e.g. 'chrome'. */
  readonly kind: BrowserKind;

  /**
   * Make sure a browser is reachable for the given options, starting one when
   * the strategy allows it. Returns launch bookkeeping for the caller.
   */
  ensureRunning(options: BrowserConnectOptions): Promise<BrowserLaunchInfo>;

  /**
   * Create an UNCONNECTED interface instance bound to the given options.
   * The caller is responsible for calling `connect()`.
   */
  create(options: BrowserConnectOptions): BrowserInterface;

  /**
   * True when a browser started by {@link ensureRunning} should be terminated
   * together with the interface.
   */
  ownsProcess?(info: BrowserLaunchInfo): boolean;

  /** Terminate a browser process previously started by this provider. */
  terminate?(info: BrowserLaunchInfo): void;
}

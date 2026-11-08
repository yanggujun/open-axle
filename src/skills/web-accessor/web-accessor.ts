// web-accessor skill — drives a live browser through the browser abstraction.
//
// This skill is intentionally browser-AGNOSTIC:
//   * it never imports a concrete browser implementation;
//   * it never speaks a browser-specific protocol;
//   * it never launches or probes a browser itself.
//
// It only uses the BrowserInterface contract and asks the browser factory for
// an instance. Which engine actually backs that instance is invisible here —
// Chrome happens to be the default backend the factory registers.
//
// Connection strategy is expressed with the `mode` property and resolved by the
// factory:
//   mode=launch -> start a NEW browser exposing a debugging port (first run)
//   mode=attach -> only reuse an ALREADY-RUNNING browser that exposes one
//   mode=auto   -> reuse when one answers, otherwise start one (default)

import { Runtime, ExecutionResponse, extractJson, getSequential } from '../../common/common';
import { BrowserConnectOptions, BrowserInterface } from '../../browser/browser-interface';
import { closeBrowserInterface, getBrowserInterface } from '../../browser/browser-factory';

export const ACTION_NAME = 'access_web';

// ---------------------------------------------------------------------------
// Value coercion helpers (payloads arrive as strings from JSON tool calls)
// ---------------------------------------------------------------------------

function _toBool(value: any, def: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(v)) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return def;
}

function _toInt(value: any, def: number): number {
  if (value === null || value === undefined || value === '') return def;
  const n = parseInt(String(value).trim(), 10);
  return isNaN(n) ? def : n;
}

function _toNum(value: any, def: number): number {
  if (value === null || value === undefined || value === '') return def;
  const n = Number(String(value).trim());
  return isNaN(n) ? def : n;
}

function _toStr(value: any, def: string): string {
  if (value === null || value === undefined) return def;
  const s = String(value);
  return s === '' ? def : s;
}

// ---------------------------------------------------------------------------
// URL alias resolution (skill config, e.g. .skill.config)
//
// The web skill config maps a friendly alias to a URL:
//
//   { "skill": "access_web",
//     "config_items": [
//       { "name": "JIRA", "value": "https://jira.tools.sap/secure/Dashboard.jspa" }
//     ] }
//
// A caller may then pass `url: "JIRA"` and the alias is expanded into the
// configured URL before the browser is touched. The skill configs are already
// loaded in memory on the runtime (`fullSkillConfig`), so nothing is read from
// disk here. Values that match no alias are passed through unchanged, which
// keeps plain URLs working exactly as before.
// ---------------------------------------------------------------------------

function _accessWebConfigItems(runtime?: Runtime): any[] {
  if (!runtime) return [];
  const config: any =
    (runtime as any).fullSkillConfig ??
    (runtime as any).fullskillconfig ??
    (runtime as any).skillConfig;
  if (!config) return [];

  const configs: any[] = Array.isArray(config.skill_configs)
    ? config.skill_configs
    : Array.isArray(config)
      ? config
      : [];

  const webConfig = configs.find(
    (entry: any) => entry && String(entry.skill ?? '').trim().toLowerCase() === ACTION_NAME
  );
  const items = webConfig && webConfig.config_items;
  return Array.isArray(items) ? items : [];
}

/**
 * Replace a URL alias with the URL configured for it in the web skill config.
 *
 * Aliases are matched case-insensitively on the trimmed value and compared
 * against the configured item `name`; the item `value` wins (a plain URL string,
 * or the `url` field when the value is an object). When nothing matches — or
 * when the configured value is empty — the supplied value is returned as-is.
 */
function _resolveUrlAlias(value: string, runtime?: Runtime): string {
  const input = (value ?? '').trim();
  if (!input) return input;

  // Fallback contract: the caller ALWAYS keeps the value it supplied unless an
  // alias matches AND expands into a usable URL. An unknown alias, a skipped
  // skill config, an empty configured value or a malformed `fullSkillConfig`
  // therefore all degrade to "just use the original url", never to an error.
  let resolved = input;
  try {
    const items = _accessWebConfigItems(runtime);
    if (items.length === 0) return resolved;

    const wanted = input.toLowerCase();
    for (const item of items) {
      if (!item || String(item.name ?? '').trim().toLowerCase() !== wanted) continue;

      const raw = item.value;
      const candidate = raw && typeof raw === 'object'
        ? String(raw.url ?? '').trim()
        : String(raw ?? '').trim();
      // Alias found but no usable URL configured: keep the original value.
      if (!candidate) return resolved;

      resolved = candidate;
      break;
    }
  } catch {
    // Config missing or shaped unexpectedly: fall back to the original value.
    return input;
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const SUPPORTED_OPERATIONS = [
  'connect', 'targets', 'navigate', 'goBack', 'goForward',
  'click', 'doubleClick', 'tripleClick',
  'clickElementByIndex', 'focusElementByIndex',
  'type', 'getElementText', 'getPageInfo', 'getPageState',
  'evaluate', 'close',
];

const DEFAULT_TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// Payload normalization
// ---------------------------------------------------------------------------

function _normalize(payload: string | Record<string, any>, runtime?: Runtime): Record<string, any> {
  const raw = extractJson(payload) ?? {};
  const [sequential, nextPrompt] = getSequential(raw as Record<string, any>);

  const props: Record<string, any> = {};
  for (const p of (raw as Record<string, any>).properties ?? []) {
    if (p && typeof p.name === 'string') props[p.name] = p.value;
  }

  const action = _toStr((raw as Record<string, any>).action, ACTION_NAME).trim();
  if (action !== ACTION_NAME && action !== 'web_accessor' && action !== 'web-accessor') {
    throw new Error('Unsupported action: ' + action + " (expected '" + ACTION_NAME + "')");
  }

  const operation = _toStr(props.operation, 'connect').trim();
  if (SUPPORTED_OPERATIONS.indexOf(operation) === -1) {
    throw new Error("Unsupported operation: '" + operation + "'. Supported: " + SUPPORTED_OPERATIONS.join(', '));
  }

  const mode = _toStr(props.mode, 'auto').trim().toLowerCase();
  if (['auto', 'attach', 'launch'].indexOf(mode) === -1) {
    throw new Error("Unsupported mode: '" + mode + "'. Supported: auto, attach, launch");
  }

  let timeout = _toInt(props.timeout, DEFAULT_TIMEOUT);
  if (timeout < 1000) timeout = 1000;
  if (timeout > 120000) timeout = 120000;

  // NOTE: `host` and `port` are deliberately NOT accepted. The browser endpoint
  // is fixed at localhost:9222 by the browser layer, so exposing them here would
  // only let a caller believe the session could be redirected elsewhere.
  //
  // NOTE: URL-ish properties may be either a real URL or an alias defined in the
  // web skill config; both are resolved here so the browser layer only ever sees
  // a concrete URL.
  return {
    operation,
    mode,
    targetId: _toStr(props.targetId, '').trim(),
    targetUrl: _resolveUrlAlias(_toStr(props.targetUrl, '').trim(), runtime),
    // `chromePath` is kept for backwards compatibility and simply forwarded as
    // the generic executable path of whichever backend the factory provides.
    executablePath: _toStr(props.executablePath, _toStr(props.chromePath, '')).trim(),
    userDataDir: _toStr(props.userDataDir, '').trim(),
    headless: _toBool(props.headless, false),
    startUrl: _resolveUrlAlias(_toStr(props.startUrl, 'about:blank').trim(), runtime) || 'about:blank',
    launchTimeout: _toInt(props.launchTimeout, 20000),
    killChromeOnClose: _toBool(props.killChromeOnClose, false),
    url: _resolveUrlAlias(_toStr(props.url, '').trim(), runtime),
    x: _toNum(props.x, NaN),
    y: _toNum(props.y, NaN),
    index: _toInt(props.index, -1),
    text: props.text === undefined || props.text === null ? '' : String(props.text),
    selector: _toStr(props.selector, '').trim(),
    expression: props.expression === undefined || props.expression === null ? '' : String(props.expression),
    timeout,
    sequential,
    prompt: nextPrompt,
  };
}

// ---------------------------------------------------------------------------
// Browser acquisition (delegated to the factory)
// ---------------------------------------------------------------------------

/** Last interface handed out, so `close` can release exactly that session. */
let _current: BrowserInterface | null = null;

function _connectOptions(data: Record<string, any>): BrowserConnectOptions {
  // No host/port here: the browser layer owns the endpoint (localhost:9222).
  const options: BrowserConnectOptions = {
    mode: data.mode,
    headless: data.headless,
    startUrl: data.startUrl,
    launchTimeout: data.launchTimeout,
    timeout: data.timeout,
  };

  if (data.targetId) options.targetId = data.targetId;
  if (data.targetUrl) options.targetUrl = data.targetUrl;
  if (data.executablePath) options.executablePath = data.executablePath;
  if (data.userDataDir) options.userDataDir = data.userDataDir;

  return options;
}

/**
 * Obtain a connected browser interface from the factory.
 *
 * The factory reuses a session already bound to the same endpoint, so repeated
 * skill invocations keep driving the same page.
 */
async function _acquire(data: Record<string, any>): Promise<BrowserInterface> {
  const browser = await getBrowserInterface(_connectOptions(data));
  _current = browser;
  return browser;
}

/**
 * Recognise errors that mean "the browser connection went away".
 *
 * These are recoverable: the browser is usually still running with its tabs and
 * profile intact, only our CDP socket is dead. Anything else (a bad selector, a
 * missing property, a timeout) must be reported to the caller instead of being
 * silently retried.
 */
function _isConnectionLoss(error: any): boolean {
  const message = String((error && error.message) || error || '').toLowerCase();
  const markers = [
    'websocket is not open',
    'readystate 3',
    'target closed',
    'session closed',
    'cdp connection closed',
    'connection is not open',
    'chrome not connected',
    'not connected',
    'socket hang up',
    'econnreset',
    'epipe',
  ];
  return markers.some((marker) => message.indexOf(marker) !== -1);
}

/**
 * Run an operation, transparently recovering ONCE from a lost connection.
 *
 * A CDP socket can die between skill invocations (tab closed, browser
 * restarted, target swapped by navigation). When that happens the stale session
 * is dropped WITHOUT killing the browser — the user's window, tabs and profile
 * stay alive — a fresh connection is acquired and the operation is retried a
 * single time.
 */
async function _runWithRetry(data: Record<string, any>): Promise<string> {
  try {
    return await _runOperation(data);
  } catch (error: any) {
    // `close` is never retried: it is the teardown path itself.
    if (data.operation === 'close' || !_isConnectionLoss(error)) {
      throw error;
    }

    const stale = _current;
    _current = null;
    if (stale) {
      try {
        await closeBrowserInterface(stale, false);
      } catch { /* already gone */ }
    }

    return await _runOperation(data);
  }
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function _formatState(state: any): string[] {
  if (!state) return [];
  return [
    'URL: ' + state.url,
    'Title: ' + state.title,
    'readyState: ' + state.readyState,
    'viewport: ' + state.viewportSize.width + 'x' + state.viewportSize.height,
    'scroll: ' + state.scrollPosition.x + ',' + state.scrollPosition.y,
  ];
}

// ---------------------------------------------------------------------------
// Operation dispatch
// ---------------------------------------------------------------------------

async function _runOperation(data: Record<string, any>): Promise<string> {
  const op: string = data.operation;

  // `close` must not acquire a browser: doing so could START one just to shut
  // it down again. It only releases the session this skill already holds.
  if (op === 'close') {
    const browser = _current;
    if (!browser) {
      return 'No active browser session to close.';
    }
    _current = null;
    await closeBrowserInterface(browser, data.killChromeOnClose);
    return data.killChromeOnClose
      ? 'Closed the browser session and terminated the browser process this session started.'
      : 'Closed the browser session.';
  }

  const browser = await _acquire(data);

  switch (op) {
    case 'connect': {
      // The endpoint is never surfaced: the browser layer pins it at
      // localhost:9222 with one persistent profile, so there is nothing for the
      // caller to configure or report.
      const lines = [
        'Connected to the browser (backend: ' + browser.kind + ').',
      ];
      try {
        const state = await browser.getPageState();
        lines.push(..._formatState(state));
      } catch { /* page state is best-effort */ }
      try {
        const info = await browser.getPageInfo();
        if (info) {
          lines.push('');
          lines.push(info);
        }
      } catch { /* page info is best-effort */ }
      return lines.join('\n');
    }

    case 'targets': {
      const targets = await browser.listTargets();
      if (targets.length === 0) {
        return 'No debuggable browser targets found.';
      }
      const lines = ['Debuggable browser targets:'];
      for (const t of targets) {
        lines.push('- [' + t.type + '] ' + t.title + ' <' + t.url + '> id=' + t.id);
      }
      return lines.join('\n');
    }

    case 'navigate': {
      if (!data.url) throw new Error("Operation 'navigate' requires the 'url' property.");
      const result = await browser.navigate(data.url);
      const lines = [result.navigation];
      lines.push(..._formatState(result.pageState));
      return lines.join('\n');
    }

    case 'goBack': {
      const result = await browser.goBack();
      const lines = [result.navigation];
      lines.push(..._formatState(result.pageState));
      return lines.join('\n');
    }

    case 'goForward': {
      const result = await browser.goForward();
      const lines = [result.navigation];
      lines.push(..._formatState(result.pageState));
      return lines.join('\n');
    }

    case 'click':
    case 'doubleClick':
    case 'tripleClick': {
      if (isNaN(data.x) || isNaN(data.y)) {
        throw new Error("Operation '" + op + "' requires numeric 'x' and 'y' properties.");
      }
      if (op === 'click') {
        await browser.click(data.x, data.y);
      } else if (op === 'doubleClick') {
        await browser.doubleClick(data.x, data.y);
      } else {
        await browser.tripleClick(data.x, data.y);
      }
      return op + ' performed at (' + data.x + ',' + data.y + ')';
    }

    case 'clickElementByIndex': {
      if (data.index < 0) {
        throw new Error("Operation 'clickElementByIndex' requires a non-negative 'index'.");
      }
      await browser.clickElementByIndex(data.index);
      return 'Clicked the interactive element at index ' + data.index + '.';
    }

    case 'focusElementByIndex': {
      if (data.index < 0) {
        throw new Error("Operation 'focusElementByIndex' requires a non-negative 'index'.");
      }
      await browser.focusElementByIndex(data.index);
      return 'Focused the interactive element at index ' + data.index + '.';
    }

    case 'type': {
      if (!data.text) throw new Error("Operation 'type' requires the 'text' property.");
      await browser.type(data.text);
      return 'Typed ' + data.text.length + ' character(s).';
    }

    case 'getElementText': {
      if (!data.selector) {
        throw new Error("Operation 'getElementText' requires the 'selector' property.");
      }
      const text = await browser.getElementText(data.selector);
      return String(text ?? '');
    }

    case 'getPageInfo': {
      const info = await browser.getPageInfo();
      return typeof info === 'string' ? info : String(info ?? '');
    }

    case 'getPageState': {
      const state = await browser.getPageState();
      return JSON.stringify(state, null, 2);
    }

    case 'evaluate': {
      if (!data.expression) {
        throw new Error("Operation 'evaluate' requires the 'expression' property.");
      }
      const value = await browser.evaluate(data.expression);
      if (typeof value === 'string') return value;
      return JSON.stringify(value, null, 2);
    }

    default:
      throw new Error("Unsupported operation: '" + op + "'");
  }
}

// ---------------------------------------------------------------------------
// Skill entry point (auto-discovered by src/core/executor.ts)
// ---------------------------------------------------------------------------

export async function execute(
  jsonPayload: string,
  runtime?: Runtime
): Promise<ExecutionResponse | string> {
  let data: Record<string, any>;
  try {
    data = _normalize(jsonPayload, runtime);
  } catch (e: any) {
    return 'Invalid payload: ' + e.message;
  }

  try {
    const content = await _runWithRetry(data);
    return new ExecutionResponse(content, data.prompt, data.sequential, true);
  } catch (e: any) {
    return 'web-accessor error (' + data.operation + '): ' + e.message;
  }
}

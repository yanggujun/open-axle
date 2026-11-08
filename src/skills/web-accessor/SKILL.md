# 🌐 Web Accessor Skill

## Overview

This skill enables the LLM to **drive a real browser**: navigating pages, reading the semantic page representation, clicking, typing, evaluating JavaScript, and walking browser history. It exposes **every** operation of the browser automation interface as a single `operation` property.

### Browser-agnostic by design

The skill never names a browser engine and contains no protocol code. It only depends on two layers:

- **`BrowserInterface`** (`src/browser/browser-interface.ts`) – the engine-neutral contract: `connect`, `isConnected`, `listTargets`, `navigate`, `click`, `doubleClick`, `tripleClick`, `focusElementByIndex`, `clickElementByIndex`, `type`, `getElementText`, `getPageInfo`, `getPageState`, `goBack`, `goForward`, `evaluate`, `close`.
- **The browser factory** (`src/browser/browser-factory.ts`) – resolves *which* engine backs the interface. Providers register themselves (Chrome is the default backend, implemented by `src/browser/chrome.ts` via `ChromeProvider`), and a session already bound to the same endpoint is reused, so consecutive payloads drive the same tab.

Swapping or adding a browser therefore never touches this skill: register another `BrowserProvider` with the factory and the same `access_web` payloads keep working.

### Choosing a browser to talk to

The `mode` property selects the connection strategy and is resolved by the factory:

- **`launch`** – start a **new browser process** exposing a debugging port (plus a dedicated profile directory). Use this on the **first run**, when nothing is listening yet.
- **`attach`** – connect to an **already-running browser** that already exposes a debugging port. Nothing is started; the factory only picks a page target.
- **`auto`** (default) – reuse a running browser when its endpoint answers, otherwise start one, so the same payload works for the first run and every later run.

The `chromePath` property is accepted for backwards compatibility and is forwarded to the factory as the backend's generic **executable path**.

### One fixed profile, one fixed port

The automation browser has **exactly one identity**. It always listens on port **9222** and always uses this profile directory:

```
~/.axle/browser-profiles/chrome-9222
(Windows: C:\Users\<you>\.axle\browser-profiles\chrome-9222)
```

#### The endpoint is not configurable

There is **no connection property** to set. The host and port are owned entirely by the browser layer — always `localhost:9222` — and exposing them would only let a payload claim a session was redirected somewhere it wasn't.

Because that single directory is reused on every launch, **cookies, logins, history and site storage persist between runs**: log into a site once and every later `access_web` call is already authenticated.

- **`userDataDir` is ignored.** The browser layer pins the profile directory; passing a different one only logs a warning. This deliberately prevents a second, orphaned profile from being created.
- **To start clean**, delete that folder. A fresh profile is then created on the next `mode="launch"`.
- **Do not point at your everyday Chrome profile** — recent Chrome builds refuse to expose a debugging port on their default profile.
- A failed launch usually means **the profile is already open in another browser**. Close that browser and retry (`operation="close"` with `killChromeOnClose=true` also works when this skill started it).

## Skill Name

`web-accessor`

## Action Name

`access_web`

## When to Use This Skill

Invoke this skill whenever the user's request implies operating a real web page in a browser. Look for phrases such as:

- "open / go to / navigate to <url>"
- "click the button / link / element ..."
- "type <text> into the field ..."
- "what does the page say / summarize the page ..."
- "run this JavaScript in the page ..."
- "read the text of the <selector> element ..."
- "go back / go forward ..."
- "close the browser / disconnect ..."

Do **NOT** use this skill when the user wants to:

- Fetch a URL's raw HTML without a browser → use `curl`.
- Read or write a local file → use `file-reader` / `file-creator` / `file-changer`.
- Run a shell command → use `cmd-runner`.

## What the LLM Must Do

When the skill is triggered, the LLM must:

1. **Extract** the following from the user's request (asking clarifying questions only if truly ambiguous):
   - **operation** (required): One of `connect`, `targets`, `navigate`, `goBack`, `goForward`, `click`, `doubleClick`, `tripleClick`, `clickElementByIndex`, `focusElementByIndex`, `type`, `getElementText`, `getPageInfo`, `getPageState`, `evaluate`, `close`. Defaults to `connect`.
   - **mode** (optional): `auto` (default), `attach`, or `launch`.
   - **targetId** (optional): Attach to a specific page target id (see the `targets` operation).
   - **targetUrl** (optional): Attach to the first page whose URL contains this value.
   - **chromePath** (optional): Explicit Chrome/Chromium executable for `launch` mode.
   - **userDataDir** (optional): Profile directory for the launched Chrome.
   - **headless** (optional): `true` to launch headless. Defaults to `false`.
   - **startUrl** (optional): Initial URL for a launched Chrome. Defaults to `about:blank`.
   - **launchTimeout** (optional): Milliseconds to wait for a launched Chrome to open its debugging port. Defaults to `20000`.
   - **killChromeOnClose** (optional): `true` to also terminate the Chrome process this skill launched when `operation="close"`.
   - **url** (required for `navigate`): The URL to open. The URL could be a plain string. Alias are defined in the app configuration.
   - **x**, **y** (required for `click` / `doubleClick` / `tripleClick`): Viewport coordinates in CSS pixels.
   - **index** (required for `clickElementByIndex` / `focusElementByIndex`): Index in the page's interactive-elements list reported by `getPageInfo`.
   - **text** (required for `type`): The text to type. Supports the special-key grammar `{Enter}`, `{Tab}`, `{Backspace}`, `{Delete}`, `{Escape}`, `{ArrowUp}`, `{ArrowDown}`, `{ArrowLeft}`, `{ArrowRight}`, `{Home}`, `{End}`, `{Ctrl+A}`, `{Ctrl+C}`, `{Ctrl+V}`, `{Ctrl+X}`, `{Ctrl+Z}`, `{Ctrl+U}`, `{Ctrl+I}`, `{Ctrl+B}`.
   - **selector** (required for `getElementText`): A CSS selector.
   - **expression** (required for `evaluate`): JavaScript evaluated in the page context; the result is returned.
   - **timeout** (optional): Per-CDP-call timeout in milliseconds, 1000–120000. Defaults to `30000`.
   - **sequential** (optional): If the result is needed as input for a follow-up AI task.
   - **prompt** (optional): Follow-up prompt for all following tasks when `sequential` is set.

2. **Produce a response containing a single pure JSON object** that STRICTLY follows the schema below. No code fences, no extra prose.

## Required JSON Output Schema

```json
{
  "action": "access_web",
  "thinking": "<ai-thinking-trace>",
  "sequential": {
    "prompt": "Follow-up prompt for all of following tasks"
  },
  "properties": [
    { "name": "operation", "value": "connect" },
    { "name": "mode", "value": "auto" },
    { "name": "url", "value": "" },
    { "name": "x", "value": "0" },
    { "name": "y", "value": "0" },
    { "name": "index", "value": "0" },
    { "name": "text", "value": "" },
    { "name": "selector", "value": "" },
    { "name": "expression", "value": "" },
    { "name": "timeout", "value": "30000" },
    { "name": "description", "value": "Establish a CDP session" }
  ]
}
```

### Field Rules

| Field               | Type    | Required                  | Notes                                                                      |
|---------------------|---------|---------------------------|----------------------------------------------------------------------------|
| `action`            | string  | Yes                       | Must be exactly `"access_web"`.                                            |
| `operation`         | string  | Yes                       | One of the 16 operations listed below. Default `"connect"`.                |
| `mode`              | string  | No                        | `auto` (default), `attach`, `launch`.                                     |
| `targetId`          | string  | No                        | Pick a specific page target.                                              |
| `targetUrl`         | string  | No                        | Pick the first page whose URL contains this substring.                     |
| `chromePath`        | string  | No                        | Chrome executable used by `launch`.                                      |
| `userDataDir`       | string  | No                        | **Ignored.** The single persistent profile `~/.axle/browser-profiles/chrome-9222` is always used, so logins survive across runs. |
| `headless`          | boolean | No                        | Default `false`.                                                          |
| `startUrl`          | string  | No                        | Default `about:blank`.                                                    |
| `launchTimeout`     | string  | No                        | Milliseconds; default `20000`.                                            |
| `killChromeOnClose` | boolean | No                        | Default `false`.                                                          |
| `url`               | string  | For `navigate`            | Absolute URL.                                                             |
| `x`, `y`            | number  | For `click` family      | Viewport coordinates.                                                     |
| `index`             | string  | For `*ByIndex` ops      | Index into the interactive-elements list.                                 |
| `text`              | string  | For `type`                | Supports `{Enter}`, `{Tab}`, `{Ctrl+A}`, ...                              |
| `selector`          | string  | For `getElementText`      | CSS selector.                                                             |
| `expression`        | string  | For `evaluate`            | JavaScript evaluated in the page.                                          |
| `timeout`           | string  | No                        | 1000–120000 ms; default `30000`.                                          |
| `description`       | string  | No                        | Human-readable purpose.                                                   |
| `sequential`        | object  | No                        | Whether the result should feed a follow-up AI task.                        |
| `prompt`            | string  | No                        | Follow-up prompt when `sequential` is present.                             |

### Supported Operations

| Operation              | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `connect`              | Establish/reuse the CDP session and report the current page.    |
| `targets`              | List attachable pages (id, title, url) without connecting.      |
| `navigate`             | Navigate to `url` and wait for `document.readyState=complete`.  |
| `goBack`               | Browser history back.                                           |
| `goForward`            | Browser history forward.                                       |
| `click`                | Left click at `x`,`y`.                                         |
| `doubleClick`          | Double click at `x`,`y`.                                       |
| `tripleClick`          | Triple click at `x`,`y`.                                       |
| `clickElementByIndex`  | Scroll to, highlight and click the element at `index`.          |
| `focusElementByIndex`  | Scroll to and focus the element at `index`.                     |
| `type`                 | Type `text` into the focused element with special-key support.   |
| `getElementText`       | `textContent` of `selector`.                                    |
| `getPageInfo`          | Semantic page representation (URL, title, interactive elements).|
| `getPageState`         | JSON page state (url, title, readyState, scroll, viewport).      |
| `evaluate`             | Evaluate `expression` in the page and return its value.         |
| `close`                | Close the CDP connection (optionally kill the launched Chrome). |

### Formatting Requirements

- The JSON output **must be valid JSON** (parseable by `json.loads`).
- All string values must properly escape special characters (`"`, `\\`, newline as `\n`, tab as `\t`).
- Do **NOT** emit multiple `web-accessor` payloads in a single response.
- `x`, `y`, `index`, `timeout` and `launchTimeout` may be sent as strings.

## Response Pattern for the LLM

A typical assistant reply should look like the following. No other output is needed. Output must be in pure JSON format.

> {
>   "action": "access_web",
>   "thinking": "Open example.com in the browser, launching Chrome if needed.",
>   "properties": [
>     { "name": "operation", "value": "navigate" },
>     { "name": "mode", "value": "auto" },
>     { "name": "url", "value": "https://example.com" },
>     { "name": "description", "value": "Navigate to example.com" }
>   ]
> }

## Decision Logic

```
User Prompt
    |
    +-- Does the request imply driving a real browser page?
    |     |
    |     +-- YES --> Pick the operation (connect/targets/navigate/click/...)
    |     |           --> choose mode: launch on first run, attach/auto afterwards
    |     |           --> Emit ONE `web-accessor` JSON payload
    |     |
    |     +-- NO  --> Do not use this skill
```

## Examples

### Example 1: First run — launch the browser, then navigate
**User:** "Open https://example.com in a browser and tell me what it says."

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "First run: nothing is listening yet, so launch the browser, then navigate and read the page.",
  "properties": [
    { "name": "operation", "value": "navigate" },
    { "name": "mode", "value": "launch" },
    { "name": "headless", "value": "false" },
    { "name": "startUrl", "value": "about:blank" },
    { "name": "url", "value": "https://example.com" },
    { "name": "description", "value": "Launch the browser and open example.com" }
  ]
}
```

### Example 2: Attach to an already-running browser
**User:** "Use the browser that's already open and show me the current page."

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "A debuggable browser is already running, so attach instead of launching a new one.",
  "properties": [
    { "name": "operation", "value": "connect" },
    { "name": "mode", "value": "attach" },
    { "name": "description", "value": "Attach to the running browser" }
  ]
}
```

To pick a specific tab rather than the default one, pass `targetUrl` (first page whose URL contains the value) or `targetId` (from the `targets` operation) instead of any connection setting.

### Example 3: Discover attachable page targets
**User:** "Which tabs can you control?"

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "List the browser page targets before attaching.",
  "properties": [
    { "name": "operation", "value": "targets" },
    { "name": "mode", "value": "attach" },
    { "name": "description", "value": "List controllable pages" }
  ]
}
```

### Example 4: Read the semantic page representation
**User:** "Summarize the page you just opened."

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "getPageInfo returns URL, title, the indexed interactive elements and the page text.",
  "properties": [
    { "name": "operation", "value": "getPageInfo" },
    { "name": "description", "value": "Read the semantic page representation" }
  ]
}
```

### Example 5: Click the Nth interactive element, then type into it
**User:** "Search for 'open axle' using the site's search box."

**LLM emits (two sequential payloads; the first is shown here):**
```json
{
  "action": "access_web",
  "thinking": "From getPageInfo the search input is interactive element [3]; click it to focus, then type.",
  "sequential": {
    "prompt": "After the click, send a type payload with text 'open axle{Enter}', then call getPageInfo and summarize the results."
  },
  "properties": [
    { "name": "operation", "value": "clickElementByIndex" },
    { "name": "index", "value": "3" },
    { "name": "description", "value": "Click the search input" }
  ]
}
```

### Example 6: Type text with special keys
**User:** "Type my query and press Enter."

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "The type operation supports the {Enter} special key.",
  "properties": [
    { "name": "operation", "value": "type" },
    { "name": "text", "value": "open axle{Enter}" },
    { "name": "description", "value": "Type the query and submit" }
  ]
}
```

### Example 7: Click by coordinates
**User:** "Click at 320, 480 on the page."

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "Coordinate click in CSS pixels.",
  "properties": [
    { "name": "operation", "value": "click" },
    { "name": "x", "value": "320" },
    { "name": "y", "value": "480" },
    { "name": "description", "value": "Click at viewport coordinates" }
  ]
}
```

### Example 8: Extract an element's text
**User:** "What is the text of the h1 on the page?"

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "Read textContent of the h1 via CSS selector.",
  "properties": [
    { "name": "operation", "value": "getElementText" },
    { "name": "selector", "value": "h1" },
    { "name": "description", "value": "Read the h1 heading text" }
  ]
}
```

### Example 9: Evaluate JavaScript in the page
**User:** "How many links are on this page?"

**LLM emits:**
```json
{
  "action": "access_web",
  "thinking": "Count anchors with document.querySelectorAll in the page context.",
  "properties": [
    { "name": "operation", "value": "evaluate" },
    { "name": "expression", "value": "document.querySelectorAll('a').length" },
    { "name": "description", "value": "Count anchors on the page" }
  ]
}
```

### Example 10: Go back, then close the session
**User:** "Go back to the previous page and shut the browser down."

**LLM emits (first payload shown):**
```json
{
  "action": "access_web",
  "thinking": "history.back() first; then close with killChromeOnClose=true so the launched Chrome exits.",
  "sequential": {
    "prompt": "After going back, send a close payload with killChromeOnClose=true and confirm the browser was shut down."
  },
  "properties": [
    { "name": "operation", "value": "goBack" },
    { "name": "description", "value": "Navigate back in history" }
  ]
}
```

## Session Behaviour

The browser connection is held by the browser factory so consecutive payloads drive the **same tab**: `connect`, `navigate`, `click`, `type`, ... all reuse it. Because the endpoint never varies, the session is reused until `operation="close"`.

Before reuse the connection is actively verified: if the underlying socket died between payloads (tab closed, browser restarted, target swapped by navigation), the stale session is discarded **without killing the browser** — your window, tabs and profile survive — and a fresh connection is opened. A connection that drops mid-operation is retried once, so a navigation that invalidates the socket recovers instead of failing.

Only a browser process **started for this session** can be terminated by `killChromeOnClose`; an attached browser is never killed — the connection is simply closed.

## Safety Guidelines

1. Never navigate to `file://` URLs or internal/private hosts unless the user explicitly asks for it.
2. Do not use `evaluate` to read credentials, tokens, cookies or other secrets from the page.
3. `mode="attach"` must never kill the user's browser; only `mode="launch"` processes may be terminated.
4. Prefer `getPageInfo` + `clickElementByIndex` over raw coordinates: it is stable across window sizes.
5. Keep `timeout` reasonable (default 30s, max 120s) so a hung page cannot block the agent.
6. Always echo the JSON payload so the user can review before execution.

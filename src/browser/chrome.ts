/*
Original Author: github/lxe/chrome-mcp MIT License
Original Code: https://raw.githubusercontent.com/lxe/chrome-mcp/refs/heads/master/src/chrome-interface.ts
*/
import CDP from 'chrome-remote-interface';
import fs from 'fs';
import path from 'path';

// Shared, browser-agnostic contracts. ChromeInterface is one implementation of
// BrowserInterface; consumers must depend on the interface, not on this class.
import {
  BrowserConnectOptions,
  BrowserInterface,
  BrowserKind,
  BrowserTarget,
  NavigationResult,
  PageState,
} from './browser-interface';
import { listDevToolsTargets, normalizeEndpoint } from './chrome-launcher';

type MouseButton = 'left' | 'right' | 'middle';

interface MouseEventOptions {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
  x: number;
  y: number;
  button?: MouseButton;
  buttons?: number;
  clickCount?: number;
}

interface SpecialKeyConfig {
  key: string;
  code: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  autoRepeat: boolean;
  isKeypad: boolean;
  isSystemKey: boolean;
}

// Function to load template file
//
// The template is optional: when it is absent the interface still works, it
// just cannot inject the cooperative ARIA helper script into the page.
function loadAriaTemplate(): string {
  const TEMPLATES_DIR = path.join(__dirname, 'runtime-templates');
  try {
    return fs.readFileSync(path.join(TEMPLATES_DIR, 'ariaInteractiveElements.js'), 'utf-8');
  } catch (error) {
    console.warn('ariaInteractiveElements template not available; continuing without it:', (error as Error).message);
    return '';
  }
}

// Chrome interface class to handle CDP interactions
//
// This is the Chrome implementation of the browser-agnostic BrowserInterface.
// Callers should obtain it through ./browser-factory.ts and program against the
// interface, so swapping the engine never touches their code.
export class ChromeInterface implements BrowserInterface {
  /** Identifies this implementation to the browser factory. */
  readonly kind: BrowserKind = 'chrome';

  private client: CDP.Client | null = null;
  private page: any | null = null;
  private ariaScriptTemplate: string = '';
  private options: BrowserConnectOptions = {};

  constructor(options: BrowserConnectOptions = {}) {
    this.applyOptions(options);
    this.ariaScriptTemplate = loadAriaTemplate();
  }

  /**
   * Merge incoming options and PIN the endpoint.
   *
   * The automation browser has exactly one identity — one host, port 9222 and
   * the single persistent profile — so the resolved values are written back
   * over whatever the caller asked for. This guarantees an instance can never
   * carry a second port or a second profile directory.
   */
  private applyOptions(options: BrowserConnectOptions): void {
    const merged: BrowserConnectOptions = { ...this.options, ...options };
    const endpoint = normalizeEndpoint(merged);
    this.options = {
      ...merged,
      host: endpoint.host,
      port: endpoint.port,
      userDataDir: endpoint.userDataDir,
    };
  }

  /**
   * Connects to Chrome and sets up necessary event listeners.
   *
   * @param options  Connection overrides (host/port/target). Whatever is passed
   *                 here wins over the options handed to the constructor.
   */
  async connect(options?: BrowserConnectOptions): Promise<boolean> {
    if (options) {
      this.applyOptions(options);
    }

    try {
      // Cast to the promise-returning overload: passing an `any`-typed options
      // object would otherwise resolve to the callback overload (returns void).
      const openClient = CDP as unknown as (options?: any) => Promise<CDP.Client>;
      const client = await openClient(await this.buildCdpOptions());
      this.client = client;

      // A CDP WebSocket can die on its own: the tab is closed, the browser is
      // restarted, or a navigation swaps the inspected target. Clear the handle
      // the moment that happens so isConnected() stops reporting a dead socket
      // as live and the factory rebuilds the session instead of reusing it.
      client.on('disconnect', () => {
        if (this.client === client) {
          this.client = null;
        }
      });

      const { Page, DOM, Runtime, Network } = client;

      // Enable necessary domains
      await Promise.all([
        Page.enable(),
        DOM.enable(),
        Runtime.enable(),
        Network.enable(),
      ]);

      // Set up simple page load handler that injects the script
      Page.loadEventFired(async () => {
        console.log('[Page Load] Load event fired, injecting ARIA script');
        await this.injectAriaScript();
      });

      return true;
    } catch (error) {
      console.error('Failed to connect to Chrome:', error);
      // Never leave a half-open handle behind: a failed connect must not make
      // isConnected() report true.
      this.client = null;
      return false;
    }
  }

  /**
   * True when this interface currently holds a CDP connection.
   *
   * This is a cheap flag: it becomes false as soon as the socket reports a
   * disconnect. Use {@link ping} when you need proof the socket still works.
   */
  isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Verify the CDP connection is genuinely usable.
   *
   * A socket can look open while its inspected target is already gone, so this
   * round-trips a trivial Runtime.evaluate. Returns false instead of throwing,
   * so callers can use it purely as a health check before reusing a session.
   */
  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return true;
    } catch {
      // The target/session is gone: drop the handle so the next connect starts
      // from a clean state instead of reusing a dead socket.
      this.client = null;
      return false;
    }
  }

  /**
   * Enumerate the debuggable targets of the connected browser.
   *
   * Chrome exposes them over HTTP rather than CDP, so this works even when no
   * CDP session is established yet.
   */
  async listTargets(): Promise<BrowserTarget[]> {
    const endpoint = normalizeEndpoint(this.options);
    const raw = await listDevToolsTargets(endpoint.host, endpoint.port);

    return raw.map((t) => ({
      id: String(t.id || ''),
      type: String(t.type || ''),
      title: String(t.title || ''),
      url: String(t.url || ''),
      webSocketDebuggerUrl: t.webSocketDebuggerUrl ? String(t.webSocketDebuggerUrl) : undefined,
    }));
  }

  /** The connection options this interface was created with. */
  getOptions(): BrowserConnectOptions {
    return { ...this.options };
  }

  /**
   * Translate the browser-agnostic options into CDP connect options.
   *
   * A `targetId` is passed through directly; a `targetUrl` is resolved to the
   * first matching page target so the caller can address a tab by URL.
   */
  private async buildCdpOptions(): Promise<any> {
    // Always the pinned endpoint: one host, one port, no caller override.
    const endpoint = normalizeEndpoint(this.options);
    const host = endpoint.host;
    const port = endpoint.port;

    const cdpOptions: Record<string, any> = { host, port };

    if (this.options.targetId) {
      cdpOptions.target = this.options.targetId;
    } else if (this.options.targetUrl) {
      try {
        const wanted = this.options.targetUrl;
        const targets = await listDevToolsTargets(host, port);
        const match = targets.find(
          (t) => String(t.type) === 'page' && String(t.url || '').indexOf(wanted) !== -1 && t.webSocketDebuggerUrl
        );
        if (match && match.id) {
          cdpOptions.target = String(match.id);
        }
      } catch {
        // Fall back to Chrome's default target selection.
      }
    }

    return cdpOptions;
  }

  /**
   * Injects the ARIA interactive elements script into the page
   */
  private async injectAriaScript() {
    if (!this.client?.Runtime) return;
    if (!this.ariaScriptTemplate) return;

    console.log('[ARIA] Injecting ARIA interactive elements script');

    await this.client.Runtime.evaluate({
      expression: this.ariaScriptTemplate
    });
  }

  /**
   * Navigates to a URL and waits for page load
   */
  async navigate(url: string): Promise<NavigationResult> {
    if (!this.client) throw new Error('Chrome not connected');
    
    console.log(`[Navigation] Starting navigation to ${url}`);
    
    try {
      const NAVIGATION_TIMEOUT = 30000; // 30 seconds timeout
      
      await Promise.race([
        this.client.Page.navigate({ url }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Navigation timeout')), NAVIGATION_TIMEOUT)
        )
      ]);

      console.log('[Navigation] Navigation successful');
      
      const pageInfo = await this.getPageInfo();
      const pageState = await this.getPageState();

      return {
        navigation: `Successfully navigated to ${url}`,
        pageInfo,
        pageState
      };

    } catch (error) {
      console.error('[Navigation] Navigation error:', error);
      throw error;
    }
  }

  /**
   * Simulates a mouse click at specified coordinates with verification
   */
  async click(x: number, y: number) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Input, Runtime } = this.client;

    // Get element info before clicking
    const preClickInfo = await Runtime.evaluate({
      expression: `
        (function() {
          const element = document.elementFromPoint(${x}, ${y});
          return element ? {
            tagName: element.tagName,
            href: element instanceof HTMLAnchorElement ? element.href : null,
            type: element instanceof HTMLInputElement ? element.type : null,
            isInteractive: (
              element instanceof HTMLButtonElement || 
              element instanceof HTMLAnchorElement ||
              element instanceof HTMLInputElement ||
              element.hasAttribute('role') ||
              window.getComputedStyle(element).cursor === 'pointer'
            )
          } : null;
        })()
      `,
      returnByValue: true
    });

    const elementInfo = preClickInfo.result.value;
    console.log('[Click] Clicking element:', elementInfo);

    // Dispatch a complete mouse event sequence
    const dispatchMouseEvent = async (options: MouseEventOptions) => {
      await Input.dispatchMouseEvent({
        ...options,
        button: 'left',
        buttons: options.type === 'mouseMoved' ? 0 : 1,
        clickCount: (options.type === 'mousePressed' || options.type === 'mouseReleased') ? 1 : 0,
      });
    };

    // Natural mouse movement sequence with hover first
    await dispatchMouseEvent({ type: 'mouseMoved', x: x - 50, y: y - 50 });
    await new Promise(resolve => setTimeout(resolve, 50)); // Small delay for hover
    await dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await new Promise(resolve => setTimeout(resolve, 50)); // Small delay for hover effect

    // Click sequence
    await dispatchMouseEvent({ type: 'mousePressed', x, y });
    await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between press and release
    await dispatchMouseEvent({ type: 'mouseReleased', x, y, buttons: 0 });

    // Verify the click had an effect and show visual feedback
    await Runtime.evaluate({
      expression: `
        (function() {
          const element = document.elementFromPoint(${x}, ${y});
          if (element) {
            // Add a brief flash to show where we clicked
            const div = document.createElement('div');
            div.style.position = 'fixed';
            div.style.left = '${x}px';
            div.style.top = '${y}px';
            div.style.width = '20px';
            div.style.height = '20px';
            div.style.backgroundColor = 'rgba(255, 255, 0, 0.5)';
            div.style.borderRadius = '50%';
            div.style.pointerEvents = 'none';
            div.style.zIndex = '999999';
            div.style.transition = 'all 0.3s ease-out';
            document.body.appendChild(div);
            
            // Animate the feedback
            setTimeout(() => {
              div.style.transform = 'scale(1.5)';
              div.style.opacity = '0';
              setTimeout(() => div.remove(), 300);
            }, 50);

            // For links, verify navigation started
            if (element instanceof HTMLAnchorElement) {
              element.dispatchEvent(new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
              }));
            }
          }
        })()
      `
    });

    // Additional delay for link clicks to start navigation
    if (elementInfo?.href) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Simulates a double click at specified coordinates
   */
  async doubleClick(x: number, y: number) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Input } = this.client;

    const dispatchMouseEvent = async (options: MouseEventOptions) => {
      await Input.dispatchMouseEvent({
        ...options,
        button: 'left',
        buttons: options.type === 'mouseMoved' ? 0 : 1,
        clickCount: (options.type === 'mousePressed' || options.type === 'mouseReleased') ? 2 : 0,
      });
    };

    // Natural mouse movement sequence with double click
    await dispatchMouseEvent({ type: 'mouseMoved', x: x - 50, y: y - 50 });
    await dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await dispatchMouseEvent({ type: 'mousePressed', x, y });
    await dispatchMouseEvent({ type: 'mouseReleased', x, y, buttons: 0 });
  }

  /**
   * Simulates a triple click at specified coordinates
   */
  async tripleClick(x: number, y: number) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Input } = this.client;

    const dispatchMouseEvent = async (options: MouseEventOptions) => {
      await Input.dispatchMouseEvent({
        ...options,
        button: 'left',
        buttons: options.type === 'mouseMoved' ? 0 : 1,
        clickCount: (options.type === 'mousePressed' || options.type === 'mouseReleased') ? 3 : 0,
      });
    };

    // Natural mouse movement sequence with triple click
    await dispatchMouseEvent({ type: 'mouseMoved', x: x - 50, y: y - 50 });
    await dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await dispatchMouseEvent({ type: 'mousePressed', x, y });
    await dispatchMouseEvent({ type: 'mouseReleased', x, y, buttons: 0 });
  }

  /**
   * Focuses an element by its index in the interactive elements array
   */
  async focusElementByIndex(index: number) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Runtime } = this.client;

    // Get element and focus it
    const { result } = await Runtime.evaluate({
      expression: `
        (function() {
          const element = window.interactiveElements[${index}];
          if (!element) throw new Error('Element not found at index ' + ${index});
          
          // Scroll into view with smooth behavior
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Wait a bit for scroll to complete
          return new Promise(resolve => {
            setTimeout(() => {
              element.focus();
              resolve(true);
            }, 1000);
          });
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });

    if (result.subtype === 'error') {
      throw new Error(result.description);
    }

    // Highlight the element after focusing
    await this.highlightElement(`window.interactiveElements[${index}]`);
  }

  /**
   * Clicks an element by its index in the interactive elements array
   */
  async clickElementByIndex(index: number) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Runtime } = this.client;

    // Get element info and coordinates
    const elementInfo = await Runtime.evaluate({
      expression: `
        (function() {
          const element = window.interactiveElements[${index}];
          if (!element) throw new Error('Element not found at index ' + ${index});
          
          // Scroll into view with smooth behavior
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          return new Promise(resolve => {
            setTimeout(() => {
              const rect = element.getBoundingClientRect();
              resolve({
                rect: {
                  x: Math.round(rect.left + (rect.width * 0.5)), // Click in center
                  y: Math.round(rect.top + (rect.height * 0.5))
                },
                tagName: element.tagName,
                href: element instanceof HTMLAnchorElement ? element.href : null,
                type: element instanceof HTMLInputElement ? element.type : null
              });
            }, 1000); // Wait for scroll
          });
        })()
      `,
      awaitPromise: true,
      returnByValue: true
    });

    if (elementInfo.result.subtype === 'error') {
      throw new Error(elementInfo.result.description);
    }

    const { x, y } = elementInfo.result.value.rect;

    // Highlight the element before clicking
    await this.highlightElement(`window.interactiveElements[${index}]`);
    
    // Add a small delay to make the highlight visible
    await new Promise(resolve => setTimeout(resolve, 300));

    // Perform the physical click
    await this.click(x, y);

    // For inputs, ensure they're focused after click
    if (elementInfo.result.value.type) {
      await Runtime.evaluate({
        expression: `window.interactiveElements[${index}].focus()`
      });
    }
  }

  /**
   * Types text with support for special keys
   */
  async type(text: string) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Input } = this.client;

    // Add random delay between keystrokes to simulate human typing
    const getRandomDelay = () => {
      // Base delay between 100-200ms with occasional longer pauses
      return Math.random() * 20 + 20;
    };

    const specialKeys: Record<string, SpecialKeyConfig> = {
      Enter: {
        key: 'Enter',
        code: 'Enter',
        text: '\r',
        unmodifiedText: '\r',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
      },
      Tab: {
        key: 'Tab',
        code: 'Tab',
        windowsVirtualKeyCode: 9,
        nativeVirtualKeyCode: 9,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
      },
      Backspace: {
        key: 'Backspace',
        code: 'Backspace',
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
      },
      ArrowUp: {
        key: 'ArrowUp',
        code: 'ArrowUp',
        windowsVirtualKeyCode: 38,
        nativeVirtualKeyCode: 38,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
      },
      ArrowDown: {
        key: 'ArrowDown',
        code: 'ArrowDown',
        windowsVirtualKeyCode: 40,
        nativeVirtualKeyCode: 40,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
      },
      ArrowLeft: {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        windowsVirtualKeyCode: 37,
        nativeVirtualKeyCode: 37,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
      },
      ArrowRight: {
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
        nativeVirtualKeyCode: 39,
        autoRepeat: false,
        isKeypad: false,
        isSystemKey: false,
      },
      'Ctrl+A': { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, autoRepeat: false, isKeypad: false, isSystemKey: false },
      'Ctrl+B': { key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66, autoRepeat: false, isKeypad: false, isSystemKey: false },
      'Ctrl+C': { key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, autoRepeat: false, isKeypad: false, isSystemKey: false },
      'Ctrl+I': { key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, nativeVirtualKeyCode: 73, autoRepeat: false, isKeypad: false, isSystemKey: false },
      'Ctrl+U': { key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, nativeVirtualKeyCode: 85, autoRepeat: false, isKeypad: false, isSystemKey: false },
      'Ctrl+V': { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, autoRepeat: false, isKeypad: false, isSystemKey: false },
      'Ctrl+X': { key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88, autoRepeat: false, isKeypad: false, isSystemKey: false },
      'Ctrl+Z': { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, autoRepeat: false, isKeypad: false, isSystemKey: false },
    };

    const handleModifierKey = async (keyConfig: SpecialKeyConfig, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }) => {
      if (!this.client) return;
      const { Input } = this.client;

      if (modifiers.ctrl) {
        await Input.dispatchKeyEvent({
          type: 'keyDown',
          key: 'Control',
          code: 'ControlLeft',
          windowsVirtualKeyCode: 17,
          nativeVirtualKeyCode: 17,
          modifiers: 2,
          isSystemKey: false
        });
      }

      await Input.dispatchKeyEvent({
        type: 'keyDown',
        ...keyConfig,
        modifiers: modifiers.ctrl ? 2 : 0,
      });

      await Input.dispatchKeyEvent({
        type: 'keyUp',
        ...keyConfig,
        modifiers: modifiers.ctrl ? 2 : 0,
      });

      if (modifiers.ctrl) {
        await Input.dispatchKeyEvent({
          type: 'keyUp',
          key: 'Control',
          code: 'ControlLeft',
          windowsVirtualKeyCode: 17,
          nativeVirtualKeyCode: 17,
          modifiers: 0,
          isSystemKey: false
        });
      }
    };

    const parts = text.split(/(\{[^}]+\})/);

    for (const part of parts) {
      if (part.startsWith('{') && part.endsWith('}')) {
        const keyName = part.slice(1, -1);
        if (keyName in specialKeys) {
          const keyConfig = specialKeys[keyName];

          if (keyName.startsWith('Ctrl+')) {
            await handleModifierKey(keyConfig, { ctrl: true });
          } else {
            await Input.dispatchKeyEvent({
              type: 'keyDown',
              ...keyConfig,
            });

            if (keyName === 'Enter') {
              await Input.dispatchKeyEvent({
                type: 'char',
                text: '\r',
                unmodifiedText: '\r',
                windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13,
                autoRepeat: false,
                isKeypad: false,
                isSystemKey: false,
              });
            }

            await Input.dispatchKeyEvent({
              type: 'keyUp',
              ...keyConfig,
            });

            await new Promise(resolve => setTimeout(resolve, 50));

            if (keyName === 'Enter' || keyName === 'Tab') {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        } else {
          for (const char of part) {
            // Add random delay before each keystroke
            await new Promise(resolve => setTimeout(resolve, getRandomDelay()));

            await Input.dispatchKeyEvent({
              type: 'keyDown',
              text: char,
              unmodifiedText: char,
              key: char,
              code: `Key${char.toUpperCase()}`,
            });
            await Input.dispatchKeyEvent({
              type: 'keyUp',
              text: char,
              unmodifiedText: char,
              key: char,
              code: `Key${char.toUpperCase()}`,
            });
          }
        }
      } else {
        for (const char of part) {
          // Add random delay before each keystroke
          await new Promise(resolve => setTimeout(resolve, getRandomDelay()));

          await Input.dispatchKeyEvent({
            type: 'keyDown',
            text: char,
            unmodifiedText: char,
            key: char,
            code: `Key${char.toUpperCase()}`,
          });
          await Input.dispatchKeyEvent({
            type: 'keyUp',
            text: char,
            unmodifiedText: char,
            key: char,
            code: `Key${char.toUpperCase()}`,
          });
        }
      }
    }

    // Add a slightly longer delay after finishing typing
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  /**
   * Gets text content of an element by selector
   */
  async getElementText(selector: string): Promise<string> {
    if (!this.client) throw new Error('Chrome not connected');
    const { Runtime } = this.client;

    const result = await Runtime.evaluate({
      expression: `document.querySelector('${selector}')?.textContent || ''`,
    });

    return result.result.value;
  }

  /**
   * Closes the Chrome connection
   */
  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.page = null;
    }
  }

  /**
   * Gets semantic information about the page
   */
  async getPageInfo() {
    if (!this.client) throw new Error('Chrome not connected');
    const { Runtime } = this.client;

    const { result } = await Runtime.evaluate({
      expression: 'window.createTextRepresentation(); window.textRepresentation || "Page text representation not available"',
      returnByValue: true
    });

    return result.value;
  }

  /**
   * Highlights an element briefly before interaction
   */
  private async highlightElement(element: string) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Runtime } = this.client;

    await Runtime.evaluate({
      expression: `
        (function() {
          const el = ${element};
          if (!el) return;
          
          // Store original styles
          const originalOutline = el.style.outline;
          const originalOutlineOffset = el.style.outlineOffset;
          
          // Add highlight effect
          el.style.outline = '2px solid #007AFF';
          el.style.outlineOffset = '2px';
          
          // Remove highlight after animation
          setTimeout(() => {
            el.style.outline = originalOutline;
            el.style.outlineOffset = originalOutlineOffset;
          }, 500);
        })()
      `
    });
  }

  /**
   * Gets the current page state
   */
  async getPageState(): Promise<PageState> {
    if (!this.client) throw new Error('Chrome not connected');
    const { Runtime } = this.client;

    const result = await Runtime.evaluate({
      expression: `
        (function() {
          return {
            url: window.location.href,
            title: document.title,
            readyState: document.readyState,
            scrollPosition: {
              x: window.scrollX,
              y: window.scrollY
            },
            viewportSize: {
              width: window.innerWidth,
              height: window.innerHeight
            }
          };
        })()
      `,
      returnByValue: true,
    });

    return result.result.value;
  }

  /**
   * Navigates back in history
   */
  async goBack(): Promise<NavigationResult> {
    if (!this.client) throw new Error('Chrome not connected');
    
    console.log('[Navigation] Going back in history');
    await this.client.Page.navigate({ url: 'javascript:history.back()' });
    
    const pageInfo = await this.getPageInfo();
    const pageState = await this.getPageState();
    
    return {
      navigation: 'Navigated back in history',
      pageInfo,
      pageState
    };
  }

  /**
   * Navigates forward in history
   */
  async goForward(): Promise<NavigationResult> {
    if (!this.client) throw new Error('Chrome not connected');
    
    console.log('[Navigation] Going forward in history');
    await this.client.Page.navigate({ url: 'javascript:history.forward()' });
    
    const pageInfo = await this.getPageInfo();
    const pageState = await this.getPageState();
    
    return {
      navigation: 'Navigated forward in history',
      pageInfo,
      pageState
    };
  }

  /**
   * Evaluates JavaScript code in the page context
   */
  async evaluate(expression: string) {
    if (!this.client) throw new Error('Chrome not connected');
    const { Runtime } = this.client;

    const result = await Runtime.evaluate({
      expression,
      returnByValue: true
    });

    return result.result.value;
  }
}

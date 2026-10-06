export interface Protocol {
  message: string;
  content: string;
  format: string; // text, hyperlink, path, md, py, java, ...
}

/** Simple event object mimicking asyncio.Event */
class AsyncEvent {
  private _isSet: boolean = false;
  private _waiters: Array<() => void> = [];

  isSet(): boolean {
    return this._isSet;
  }

  set(): void {
    this._isSet = true;
    for (const resolve of this._waiters) {
      resolve();
    }
    this._waiters = [];
  }

  clear(): void {
    this._isSet = false;
  }

  wait(): Promise<void> {
    if (this._isSet) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve);
    });
  }
}

export abstract class Conduit {
  abstract send(message: string, format?: string, content?: string): void;
  abstract sendAsync(message: string, format?: string, content?: string): Promise<void>;
}

export class QueuedConduit extends Conduit {
  private _queue: any[] = [];
  private _event: AsyncEvent = new AsyncEvent();
  private _subscribers: Array<(message: any) => Promise<void>> = [];
  private _running: boolean = false;
  private _task: Promise<void> | null = null;
  private _thread: any = null;

  // --- Conduit interface ---

  send(message: string, format: string = '', content: string = ''): void {
    const protocol: Protocol = { message, content, format };
    this.enqueue(protocol);
  }

  async sendAsync(message: string, format: string = '', content: string = ''): Promise<void> {
    const protocol: Protocol = { message, content, format };
    await this.enqueueAsync(protocol);
  }

  // --- Public API for callers ---

  enqueue(message: any): void {
    this._queue.push(message);
    this._event.set();
  }

  async enqueueAsync(message: any): Promise<void> {
    this._queue.push(message);
    this._event.set();
  }

  subscribe(callback: (message: any) => Promise<void>): void {
    this._subscribers.push(callback);
  }

  // --- Lifecycle ---

  start(): void {
    if (this._running) {
      return;
    }
    this._running = true;
    // In a browser/Node environment, there's always an event loop.
    // We simply start the async processing loop.
    this._task = this._processLoop();
  }

  stop(): void {
    this._running = false;
    this._event.set();
  }

  // --- Internal ---

  private async _processLoop(): Promise<void> {
    while (this._running) {
      if (this._queue.length === 0) {
        // No messages yet - wait for the event to be set by enqueue().
        this._event.clear();
        await this._event.wait();
        continue;
      }

      const message = this._queue.shift();
      for (const callback of this._subscribers) {
        try {
          await callback(message);
        } catch (e: any) {
          console.log(`QueuedConduit: subscriber error: ${e}`);
        }
      }
    }
  }
}

export class ConsoleConduit extends Conduit {
  send(message: string, format: string = '', content: string = ''): void {
    if (message) {
      console.log(message);
    }
  }

  async sendAsync(message: string, format: string = '', content: string = ''): Promise<void> {
    if (message) {
      console.log(message);
    }
  }
}

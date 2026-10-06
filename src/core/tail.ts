/**
 * tail.ts - a TypeScript re-implementation of the Linux `tail -f` utility.
 *
 * Behaviour:
 *   1. The complete content of the file is emitted first (unless `initialBytes`
 *      is set, in which case only the last N bytes are emitted).
 *   2. The file is then followed continuously, so every byte that is appended to
 *      it is retrieved automatically and emitted through the `data` event.
 *   3. Truncation / log rotation is detected and the file is replayed from the
 *      beginning, matching the behaviour of `tail -f` on a replaced file.
 *
 * Library usage:
 *
 *   import { tailFile } from './src/core/tail';
 *
 *   const tail = tailFile('/var/log/app.log');
 *   tail.on('data', (chunk: string) => process.stdout.write(chunk));
 *   tail.on('error', (err: Error) => console.error(err.message));
 *
 * CLI usage:
 *
 *   ts-node src/core/tail.ts /var/log/app.log
 *   ts-node src/core/tail.ts /var/log/app.log --poll --start=8192
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Conduit } from './conduit';

/** Line feed character, used instead of a literal escape sequence. */
const LF = String.fromCharCode(10);

/** Carriage return character, used instead of a literal escape sequence. */
const CR = String.fromCharCode(13);

/** Options accepted by `Tail` and `tailFile`. */
export interface TailOptions {
  /** Poll interval in milliseconds, used when polling is enabled. Default: 500. */
  pollInterval?: number;
  /** When true, always poll the file instead of relying on `fs.watch`. Default: false. */
  usePolling?: boolean;
  /** When true, wait for the file to be created if it does not exist yet. Default: false. */
  follow?: boolean;
  /** Text encoding used to decode the file content. Default: 'utf8'. */
  encoding?: BufferEncoding;
  /** Maximum number of bytes read per chunk. Default: 64 KiB. */
  chunkSize?: number;
  /**
   * Number of bytes emitted from the end of the file when the tail starts.
   * 0 (the default) means: emit the entire file.
   */
  initialBytes?: number;
}

/**
 * A live follower for a single file.
 *
 * Events:
 *   - 'data'     (chunk: string)    new content read from the file
 *   - 'error'    (err: Error)       recoverable or fatal error
 *   - 'ready'    (position: number) initial content has been emitted
 *   - 'truncate' (size: number)     the file was truncated or replaced
 *   - 'watch'    (mode: string)     'fs.watch' or 'polling'
 *   - 'close'    ()                 the tail has been stopped
 *
 * Every one of these events is ALSO forwarded through the `Conduit` attached
 * with `setConduit()`, so the UI can consume the stream from the conduit
 * instead of subscribing to the EventEmitter directly. The local EventEmitter
 * stays authoritative for in-process consumers such as `lines()` and the CLI.
 */
export class Tail extends EventEmitter {
  public readonly filePath: string;

  private readonly options: Required<TailOptions>;
  private position = 0;
  private closed = false;
  private started = false;
  private watcher: fs.FSWatcher | null = null;
  private dirWatcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private conduit: Conduit | null = null;

  constructor(filePath: string, conduit: Conduit, options: TailOptions = {}) {
    super();
    this.filePath = path.resolve(filePath);
    this.conduit = conduit;
    this.options = {
      pollInterval: options.pollInterval ?? 500,
      usePolling: options.usePolling ?? false,
      follow: options.follow ?? false,
      encoding: options.encoding ?? 'utf8',
      chunkSize: options.chunkSize ?? 64 * 1024,
      initialBytes: options.initialBytes ?? 0,
    };
  }

  /**
   * Emit the whole current content of the file, then start watching it.
   * Resolves as soon as the initial content has been emitted.
   */
  async start(): Promise<this> {
    if (this.started) {
      return this;
    }
    this.started = true;

    if (!(await this.exists())) {
      if (!this.options.follow) {
        throw new Error('ENOENT: no such file or directory: ' + this.filePath);
      }
      // `tail -f` keeps waiting when the file is created later.
      await this.waitForFile();
      if (this.closed) {
        return this;
      }
    }

    if (this.options.initialBytes > 0) {
      const size = await this.size();
      this.position = Math.max(0, size - this.options.initialBytes);
    }

    // 1) show the entire (or, optionally, the last part of the) file
    await this.flush();

    // 2) automatically retrieve every change from now on
    if (!this.closed) {
      this.startWatching();
    }
    return this;
  }

  /** Stop watching the file and release every resource. */
  async stop(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopWatching();
    this.emitEvent('close');
  }

  /** Fire-and-forget alias of `stop()`. */
  close(): void {
    void this.stop();
  }

  /** Current read offset inside the file. */
  get offset(): number {
    return this.position;
  }

  /** Async iterator over the complete, live lines of the file. */
  async *lines(): AsyncGenerator<string, void, unknown> {
    let buffer = '';
    const pending: string[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    let failure: Error | null = null;

    const wake = (): void => {
      if (notify) {
        const resume = notify;
        notify = null;
        resume();
      }
    };

    const onData = (chunk: string): void => {
      buffer += chunk;
      let index = buffer.indexOf(LF);
      while (index !== -1) {
        let line = buffer.slice(0, index);
        if (line.endsWith(CR)) {
          line = line.slice(0, -1);
        }
        pending.push(line);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf(LF);
      }
      wake();
    };

    const onError = (err: Error): void => {
      failure = err;
      wake();
    };

    const onClose = (): void => {
      finished = true;
      wake();
    };

    this.on('data', onData);
    this.on('error', onError);
    this.on('close', onClose);

    try {
      for (;;) {
        if (pending.length > 0) {
          yield pending.shift() as string;
          continue;
        }
        if (failure) {
          throw failure;
        }
        if (finished) {
          break;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      if (buffer.length > 0) {
        yield buffer;
      }
    } finally {
      this.off('data', onData);
      this.off('error', onError);
      this.off('close', onClose);
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Deliver a tail event.
   *
   * The local EventEmitter is notified first: the `lines()` iterator and the
   * CLI subscribe to it directly. When a conduit is attached, the event is
   * ALSO forwarded as a Protocol message so the UI can consume the stream from
   * the conduit:
   *
   *   message = event type ('data' | 'ready' | 'truncate' | 'watch' | 'error' | 'close')
   *   format  = 'log'
   *   content = stringified payload (an Error is reduced to its message)
   */
  private emitEvent(type: string, payload?: unknown): void {

    if (!this.conduit) {
      return;
    }

    let content = '';
    if (payload instanceof Error) {
      content = payload.message;
    } else if (payload !== undefined && payload !== null) {
      content = String(payload);
    }
    this.conduit.send(type, 'log', content);
  }

  private exists(): Promise<boolean> {
    return fs.promises
      .access(this.filePath, fs.constants.F_OK)
      .then(() => true)
      .catch(() => false);
  }

  private size(): Promise<number> {
    return fs.promises
      .stat(this.filePath)
      .then((stat) => stat.size)
      .catch(() => 0);
  }

  /** Wait until the file appears on disk (used when `follow` is enabled). */
  private waitForFile(): Promise<void> {
    const directory = path.dirname(this.filePath);
    const basename = path.basename(this.filePath);

    return new Promise<void>((resolve) => {
      const cleanup = (): void => {
        if (this.dirWatcher) {
          this.dirWatcher.close();
          this.dirWatcher = null;
        }
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      };

      const check = (): void => {
        if (this.closed) {
          cleanup();
          resolve();
          return;
        }
        void this.exists().then((found) => {
          if (found) {
            cleanup();
            resolve();
          }
        });
      };

      try {
        this.dirWatcher = fs.watch(directory, (_event, filename) => {
          if (!filename || filename.toString() === basename) {
            check();
          }
        });
        this.dirWatcher.on('error', cleanup);
      } catch {
        this.dirWatcher = null;
      }

      // Polling is kept as a safety net: it covers network shares, bind mounts
      // and other volumes where fs.watch is not reliable.
      this.pollTimer = setInterval(check, this.options.pollInterval);
      check();
    });
  }

  private startWatching(): void {
    if (this.options.usePolling) {
      this.startPolling();
      return;
    }
    try {
      this.watcher = fs.watch(this.filePath, { persistent: true }, () => this.schedule());
      this.watcher.on('error', (err) => {
        this.emitEvent('error', err);
        this.startPolling();
      });
      this.emitEvent('watch', 'fs.watch');
    } catch (err) {
      this.emitEvent('error', err as Error);
      this.startPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer || this.closed) {
      return;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pollTimer = setInterval(() => this.schedule(), this.options.pollInterval);
  }

  private stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Trigger a read of any new content.
   *
   * Dispatch is delegated to the attached `Conduit`, which owns the message
   * queue and serialises delivery. The tail no longer keeps its own
   * `Promise.resolve()` chain in order to serialise reads.
   */
  private schedule(): void {
    if (this.closed) {
      return;
    }
    void this.dispatch();
  }

  /**
   * Hand the flush over to the conduit so it performs the message dispatch,
   * then read everything that is new since the last known offset.
   */
  private async dispatch(): Promise<void> {
    try {
      if (this.conduit) {
        await this.conduit.sendAsync('flush', 'log', '');
      }
      await this.flush();
    } catch (err) {
      this.emitEvent('error', err as Error);
    }
  }

  /** Read everything that is new since the last known offset. */
  private async flush(): Promise<void> {
    if (this.closed) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // The file is being rotated; the next event will pick it up again.
        return;
      }
      throw err;
    }

    if (stat.size < this.position) {
      // The file was truncated (log rotation): replay it from the beginning.
      this.position = 0;
      this.emitEvent('truncate', stat.size);
    }

    if (stat.size === this.position) {
      return;
    }

    await this.readFromPosition();
  }

  private async readFromPosition(): Promise<void> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(this.filePath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }

    try {
      const buffer = Buffer.allocUnsafe(this.options.chunkSize);
      for (;;) {
        if (this.closed) {
          break;
        }
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.position);
        if (bytesRead <= 0) {
          break;
        }
        this.position += bytesRead;
        this.emitEvent('data', buffer.toString(this.options.encoding, 0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }
}

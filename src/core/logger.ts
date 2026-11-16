import * as fs from 'fs';
import * as path from 'path';
import { getAppHome } from './config';
import { QueuedConduit } from './conduit';

export class AxleLogger {
  logFilePath: string;

  /**
   * Every log entry is PUBLISHED on this conduit instead of being written
   * inline: log() only enqueues, and exactly ONE subscriber (registered and
   * started in the constructor, see below) is the single place that touches
   * the log file.
   *
   * The queue serialises the writes: appendFileSync can no longer interleave
   * when several parts of the app log at the same time, entries keep their
   * arrival order, and a slow or failing disk write never blocks the caller
   * (the conduit catches subscriber errors and keeps draining).
   */
  private readonly conduit: QueuedConduit = new QueuedConduit();

  constructor(baseDir: string) {

    const fullPath = path.join(baseDir, 'logs')
    let fname = 'axle.log'

    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    fname = `${dateStr}-${fname}`;

    const filePath = path.join(fullPath, fname);

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '');
    }

    this.logFilePath = filePath;

    // The SINGLE subscriber: this is the ONLY code that writes to the log
    // file. log() merely publishes, so every entry reaches the file through
    // this one callback, in arrival order.
    //
    // The conduit delivers either a raw string or a Protocol (sendMessage
    // wraps the text in Protocol.message), so both shapes are accepted.
    this.conduit.subscribe(async (message: unknown): Promise<void> => {
      const entry =
        typeof message === 'string'
          ? message
          : String((message as { message?: string } | null)?.message ?? '');
      if (!entry) return;
      await fs.promises.appendFile(this.logFilePath, entry, 'utf8');
    });

    // Start the drain loop so the queued entries are processed.
    this.conduit.start();

    this.log(`Logging in ${fullPath}`);
  }

  log(content: string): void {
    const timestamp = this.formatTimestamp(new Date());
    const logEntry = `[axle] ${timestamp}\n${content}\n`;
    // Publish only: the single subscriber (see the constructor) performs the
    // actual file append, so all writes go through the conduit's queue.
    this.conduit.sendMessage(logEntry);
  }

  private formatTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
}

export const logger = new AxleLogger(getAppHome());


const MAX_SIZE = 50 * 1000; // 50k = 50000

export function truncateLogContent(input: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  if (bytes.length <= MAX_SIZE) {
    return input;
  }
  const truncatedBytes = bytes.slice(0, MAX_SIZE);
  // Decode safely, ignoring any incomplete trailing multi-byte sequence.
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(truncatedBytes) + "\n\n<content truncated>\n";
}

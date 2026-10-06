import * as fs from 'fs';
import * as path from 'path';
import { getAppHome } from './config';

export class AxleLogger {
  logFilePath: string;

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
    this.log(`Logging in ${fullPath}`);
  }

  log(content: string): void {
    const timestamp = this.formatTimestamp(new Date());
    const logEntry = `[axle] ${timestamp}\n${content}\n`;
    fs.appendFileSync(this.logFilePath, logEntry, 'utf8');
  }

  private formatTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
}

export const logger = new AxleLogger(getAppHome());
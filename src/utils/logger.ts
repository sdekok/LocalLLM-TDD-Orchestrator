import * as fs from 'fs';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private stream: fs.WriteStream | null = null;
  private minLevel: number;

  constructor(
    private logDir: string,
    level: LogLevel = 'info'
  ) {
    this.minLevel = LOG_LEVELS[level];
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `workflow-${Date.now()}.log`);
    this.stream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  private write(level: LogLevel, msg: string): void {
    if (LOG_LEVELS[level] < this.minLevel) return;
    const timestamp = new Date().toISOString();
    const line = `[${level.toUpperCase().padEnd(5)} ${timestamp}] ${msg}\n`;
    this.stream?.write(line);
    // stderr is safe for MCP servers — stdout is the JSON-RPC transport
    if (LOG_LEVELS[level] >= LOG_LEVELS.warn) {
      process.stderr.write(`[tdd-workflow] ${msg}\n`);
    }
  }

  debug(msg: string): void { this.write('debug', msg); }
  info(msg: string): void { this.write('info', msg); }
  warn(msg: string): void { this.write('warn', msg); }
  error(msg: string): void { this.write('error', msg); }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }

  closeAsync(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }
      this.stream.end(() => {
        this.stream = null;
        resolve();
      });
    });
  }
}

let _logger: Logger | null = null;
let _configuredDir: string | null = null;

export function getLogger(logDir?: string): Logger {
  const dir = logDir ?? path.join(process.cwd(), '.tdd-workflow', 'logs');

  if (_logger) {
    if (_configuredDir && dir !== _configuredDir) {
      console.warn(
        `Warning: getLogger() called with logDir="${dir}" but already initialized with "${_configuredDir}". Using existing instance.`
      );
    }
    return _logger;
  }

  _configuredDir = dir;
  _logger = new Logger(dir);
  return _logger;
}

/** Reset the singleton — for testing only */
export function _resetLogger(): void {
  _logger?.close();
  _logger = null;
  _configuredDir = null;
}

process.once('exit', () => { _logger?.close(); });
process.once('SIGTERM', () => { _logger?.closeAsync().then(() => process.exit(0)); });

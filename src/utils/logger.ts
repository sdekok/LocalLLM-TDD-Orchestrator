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
  private logStream: fs.WriteStream | null = null;
  private liveStream: fs.WriteStream | null = null;
  private minLevel: number;

  constructor(
    private logDir: string,
    level: LogLevel = 'info'
  ) {
    this.minLevel = LOG_LEVELS[level];
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `workflow-${Date.now()}.log`);
    this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
    // Fixed-name file truncated each run — safe to `tail -f .tdd-workflow/logs/live.log`
    this.liveStream = fs.createWriteStream(path.join(logDir, 'live.log'), { flags: 'w' });
  }

  private write(level: LogLevel, msg: string): void {
    if (LOG_LEVELS[level] < this.minLevel) return;
    const timestamp = new Date().toISOString();
    const line = `[${level.toUpperCase().padEnd(5)} ${timestamp}] ${msg}\n`;
    this.logStream?.write(line);
    // stderr is safe for MCP servers — stdout is the JSON-RPC transport
    if (LOG_LEVELS[level] >= LOG_LEVELS.warn) {
      process.stderr.write(`[tdd-workflow] ${msg}\n`);
    }
  }

  /** Write verbose agent output to live.log only (not the structured log). */
  stream(label: string, msg: string): void {
    const ts = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
    this.liveStream?.write(`[${ts}] [${label}] ${msg}\n`);
  }

  debug(msg: string): void { this.write('debug', msg); }
  info(msg: string): void { this.write('info', msg); }
  warn(msg: string): void { this.write('warn', msg); }
  error(msg: string): void { this.write('error', msg); }

  close(): void {
    this.logStream?.end();
    this.logStream = null;
    this.liveStream?.end();
    this.liveStream = null;
  }

  closeAsync(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.logStream && !this.liveStream) {
        resolve();
        return;
      }
      let pending = 0;
      const done = () => { if (--pending === 0) resolve(); };
      if (this.logStream) {
        pending++;
        this.logStream.end(() => { this.logStream = null; done(); });
      }
      if (this.liveStream) {
        pending++;
        this.liveStream.end(() => { this.liveStream = null; done(); });
      }
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

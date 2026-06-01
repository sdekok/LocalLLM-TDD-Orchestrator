import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger, _resetLogger, setLoggerStderrMirror } from '../../src/utils/logger.js';

describe('Logger', () => {
  let tmpDir: string;
  let logger: Logger | null = null;

  afterEach(async () => {
    // Close and flush before cleanup
    if (logger) {
      await logger.closeAsync();
      logger = null;
    }
    _resetLogger();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates log directory if it does not exist', async () => {
    tmpDir = path.join(os.tmpdir(), `logger-test-${Date.now()}-a`);
    logger = new Logger(tmpDir);
    expect(fs.existsSync(tmpDir)).toBe(true);
  });

  it('writes log entries to the structured log file', async () => {
    tmpDir = path.join(os.tmpdir(), `logger-test-${Date.now()}-b`);
    logger = new Logger(tmpDir, 'debug');
    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');
    await logger.closeAsync();

    // Two files: workflow-<timestamp>.log + live.log
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(2);

    const structuredLog = files.find(f => f.startsWith('workflow-'))!;
    const content = fs.readFileSync(path.join(tmpDir, structuredLog), 'utf-8');
    expect(content).toContain('DEBUG');
    expect(content).toContain('debug message');
    expect(content).toContain('INFO');
    expect(content).toContain('info message');
    expect(content).toContain('WARN');
    expect(content).toContain('warn message');
    expect(content).toContain('ERROR');
    expect(content).toContain('error message');
    logger = null; // already closed
  });

  it('respects minimum log level', async () => {
    tmpDir = path.join(os.tmpdir(), `logger-test-${Date.now()}-c`);
    logger = new Logger(tmpDir, 'warn');
    logger.debug('should not appear');
    logger.info('should not appear either');
    logger.warn('should appear');
    await logger.closeAsync();

    const files = fs.readdirSync(tmpDir);
    const structuredLog = files.find(f => f.startsWith('workflow-'))!;
    const content = fs.readFileSync(path.join(tmpDir, structuredLog), 'utf-8');
    expect(content).not.toContain('should not appear');
    expect(content).toContain('should appear');
    logger = null; // already closed
  });

  it('does not mirror to stderr when disabled (Pi TUI mode), but still logs to file', async () => {
    tmpDir = path.join(os.tmpdir(), `logger-test-${Date.now()}-d`);
    logger = new Logger(tmpDir, 'debug');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => { writes.push(String(chunk)); return true; }) as any);
    try {
      setLoggerStderrMirror(false);
      logger.warn('hidden warn');
      logger.error('hidden error');
      expect(writes.join('')).not.toContain('hidden');

      setLoggerStderrMirror(true);
      logger.warn('shown warn');
      expect(writes.join('')).toContain('shown warn');
    } finally {
      spy.mockRestore();
      setLoggerStderrMirror(true); // restore module default for other tests
    }

    await logger.closeAsync();
    const files = fs.readdirSync(tmpDir);
    const structuredLog = files.find(f => f.startsWith('workflow-'))!;
    const content = fs.readFileSync(path.join(tmpDir, structuredLog), 'utf-8');
    // The log file always records everything regardless of the stderr mirror.
    expect(content).toContain('hidden warn');
    expect(content).toContain('hidden error');
    logger = null; // already closed
  });
});

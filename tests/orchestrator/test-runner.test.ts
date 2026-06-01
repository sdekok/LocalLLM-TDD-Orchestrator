import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VitestRunner } from '../../src/orchestrator/test-runner.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs');
// execWithTimeout now uses child_process.spawn (own process group, killable on
// timeout). Mock spawn to return a fake child that streams output then closes 0.
vi.mock('child_process', () => {
  const { EventEmitter } = require('events');
  return {
    spawn: vi.fn((cmd: string) => {
      const child: any = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        const out = String(cmd).includes('--coverage')
          ? 'Tests 10 passed (10)\nStatements : 85.5%'
          : 'Tests 5 passed (5)';
        child.stdout.emit('data', Buffer.from(out));
        child.emit('close', 0);
      });
      return child;
    }),
  };
});

describe('VitestRunner', () => {
  let runner: VitestRunner;
  const mockProjectDir = '/mock/project';

  beforeEach(() => {
    runner = new VitestRunner();
    vi.clearAllMocks();
  });

  it('runs tests and parses metrics', async () => {
    const result = await runner.runTests(mockProjectDir, 1000);
    expect(result.passed).toBe(true);
    expect(result.metrics).toEqual({
      total: 5,
      passed: 5,
      failed: 0,
      skipped: 0
    });
  });

  it('runs coverage and parses metrics and text coverage', async () => {
    const result = await runner.runCoverage(mockProjectDir, 1000);
    expect(result.passed).toBe(true);
    expect(result.metrics?.total).toBe(10);
    expect(result.coverage?.statements).toBe(85.5);
  });

  it('runCoverage does not use --reporter=json-summary (crashes vitest v4)', async () => {
    const { spawn } = await import('child_process');
    const { EventEmitter } = await import('events');
    let capturedCmd = '';
    (spawn as any).mockImplementation((cmd: string) => {
      capturedCmd = cmd;
      const child: any = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from('')); child.emit('close', 0); });
      return child;
    });
    await runner.runCoverage('/mock/project', 5000);
    expect(capturedCmd).not.toContain('json-summary');
    expect(capturedCmd).toContain('--coverage');
  });

  it('prefers JSON coverage if available', async () => {
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify({
      total: {
        lines: { pct: 90 },
        branches: { pct: 80 },
        functions: { pct: 70 },
        statements: { pct: 60 }
      }
    }));

    const result = await runner.runCoverage(mockProjectDir, 1000);
    expect(result.coverage).toEqual({
      lines: 90,
      branches: 80,
      functions: 70,
      statements: 60
    });
  });
});

import { describe, it, expect } from 'vitest';
import { detectTestCommand, parseTestMetrics, detectCoverageCommand } from '../../src/orchestrator/quality-gates.js';
import { formatGateFailures } from '../../src/orchestrator/quality-gates.js';
import type { QualityReport } from '../../src/orchestrator/quality-gates.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('detectTestCommand', () => {
  function createProject(deps: Record<string, string>, scripts?: Record<string, string>): string {
    const dir = path.join(os.tmpdir(), `qg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: {}, devDependencies: deps, scripts: scripts || {} }, null, 2)
    );
    return dir;
  }

  it('detects vitest', async () => {
    const dir = createProject({ vitest: '1.0.0' });
    const cmd = await detectTestCommand(dir);
    expect(cmd).toBe('npx vitest run');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects jest', async () => {
    const dir = createProject({ jest: '29.0.0' });
    const cmd = await detectTestCommand(dir);
    expect(cmd).toBe('npx jest --passWithNoTests');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to npm test script', async () => {
    const dir = createProject({}, { test: 'mocha' });
    const cmd = await detectTestCommand(dir);
    expect(cmd).toBe('npm test');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no test config', async () => {
    const dir = createProject({}, { test: 'echo "Error: no test specified" && exit 1' });
    const cmd = await detectTestCommand(dir);
    expect(cmd).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no package.json', async () => {
    const dir = path.join(os.tmpdir(), `qg-test-empty-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const cmd = await detectTestCommand(dir);
    expect(cmd).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatGateFailures', () => {
  it('returns "All gates passed" when none failed', () => {
    const report: QualityReport = {
      gates: [{ gate: 'test', passed: true, output: 'ok', blocking: true }],
      allBlockingPassed: true,
    };
    expect(formatGateFailures(report)).toBe('All gates passed.');
  });

  it('formats failed blocking gates', () => {
    const report: QualityReport = {
      gates: [
        { gate: 'typescript', passed: false, output: 'error TS2345', blocking: true },
        { gate: 'tests', passed: true, output: 'ok', blocking: true },
      ],
      allBlockingPassed: false,
    };
    const result = formatGateFailures(report);
    expect(result).toContain('TYPESCRIPT');
    expect(result).toContain('BLOCKING');
    expect(result).toContain('error TS2345');
  });

  it('includes non-blocking warnings', () => {
    const report: QualityReport = {
      gates: [{ gate: 'lint', passed: false, output: '3 warnings', blocking: false }],
      allBlockingPassed: true,
    };
    const result = formatGateFailures(report);
    expect(result).toContain('WARNING');
    expect(result).toContain('3 warnings');
  });
});

describe('parseTestMetrics', () => {
  it('parses vitest output (all passing)', () => {
    const output = ' Test Files  8 passed (8)\n      Tests  94 passed (94)';
    const metrics = parseTestMetrics(output);
    expect(metrics).toEqual({ total: 94, passed: 94, failed: 0, skipped: 0 });
  });

  it('parses vitest output (with failures)', () => {
    const output = ' Test Files  1 failed | 7 passed (8)\n      Tests  2 failed | 85 passed (87)';
    const metrics = parseTestMetrics(output);
    expect(metrics).toEqual({ total: 87, passed: 85, failed: 2, skipped: 0 });
  });

  it('parses jest output', () => {
    const output = 'Tests: 1 failed, 10 passed, 11 total';
    const metrics = parseTestMetrics(output);
    expect(metrics).toEqual({ total: 11, passed: 10, failed: 1, skipped: 0 });
  });

  it('parses jest output (all passing)', () => {
    const output = 'Tests: 15 passed, 15 total';
    const metrics = parseTestMetrics(output);
    expect(metrics).toEqual({ total: 15, passed: 15, failed: 0, skipped: 0 });
  });

  it('parses mocha output', () => {
    const output = '  10 passing (45ms)\n  2 failing\n  1 pending';
    const metrics = parseTestMetrics(output);
    expect(metrics).toEqual({ total: 13, passed: 10, failed: 2, skipped: 1 });
  });

  it('parses node:test output', () => {
    const output = '# tests 5\n# pass 4\n# fail 1';
    const metrics = parseTestMetrics(output);
    expect(metrics).toEqual({ total: 5, passed: 4, failed: 1, skipped: 0 });
  });

  it('returns undefined for unrecognized output', () => {
    expect(parseTestMetrics('no test output here')).toBeUndefined();
  });
});

describe('detectCoverageCommand', () => {
  function createProject(deps: Record<string, string>, scripts?: Record<string, string>): string {
    const dir = path.join(os.tmpdir(), `cov-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: {}, devDependencies: deps, scripts: scripts || {} }, null, 2)
    );
    return dir;
  }

  it('detects existing coverage script', async () => {
    const dir = createProject({}, { 'test:coverage': 'vitest run --coverage' });
    const cmd = await detectCoverageCommand(dir, 'npx vitest run');
    expect(cmd).toBe('npm run test:coverage');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects vitest with coverage plugin', async () => {
    const dir = createProject({ vitest: '1.0.0', '@vitest/coverage-v8': '1.0.0' });
    const cmd = await detectCoverageCommand(dir, 'npx vitest run');
    expect(cmd).toContain('--coverage');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects jest coverage', async () => {
    const dir = createProject({ jest: '29.0.0' });
    const cmd = await detectCoverageCommand(dir, 'npx jest');
    expect(cmd).toContain('--coverage');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no coverage tool', async () => {
    const dir = createProject({ vitest: '1.0.0' });
    const cmd = await detectCoverageCommand(dir, 'npx vitest run');
    expect(cmd).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

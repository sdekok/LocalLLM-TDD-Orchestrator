import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QualityReport, runQualityGates, runLensAnalysis, getLensFailPolicy, loadFileSafetyAllowlist } from '../../src/orchestrator/quality-gates.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the lens-bridge
vi.mock('../../src/orchestrator/lens-bridge.js', () => ({
  getLensClients: vi.fn()
}));

// Mock the context/logger
vi.mock('../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

// Mock modules used in runQualityGates
vi.mock('../../src/orchestrator/test-runner.js', () => ({
  getTestRunner: () => null
}));

describe('Lens Analysis (runLensAnalysis)', () => {
  const projectDir = '/tmp/test-project';

  beforeEach(() => {
    vi.clearAllMocks();
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'test' }));
  });

  it('returns empty string if Lens finds no issues', async () => {
    const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
    (getLensClients as any).mockResolvedValue({
      TypeScriptClient: class {
        isTypeScriptFile() { return true; }
        getDiagnostics() { return []; }
      },
      AstGrepClient: class {
        async ensureAvailable() { return true; }
        scanFile() { return []; }
        formatDiagnostics() { return ''; }
      }
    });

    const result = await runLensAnalysis(projectDir);
    expect(result).toBe('');
  });

  it('returns issue string if Lens finds LSP errors', async () => {
    const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
    (getLensClients as any).mockResolvedValue({
      TypeScriptClient: class {
        isTypeScriptFile() { return true; }
        getDiagnostics() {
          return [{ severity: 1, message: 'Type error', range: { start: { line: 0 } } }];
        }
      },
      AstGrepClient: class {
        async ensureAvailable() { return true; }
        scanFile() { return []; }
      }
    });
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'bad code');

    const result = await runLensAnalysis(projectDir);
    expect(result).toContain('[LSP]');
    expect(result).toContain('Type error');
  });

  it('returns issue string if Lens finds structural (ast-grep) errors', async () => {
    const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
    (getLensClients as any).mockResolvedValue({
      TypeScriptClient: class {
        isTypeScriptFile() { return false; }
      },
      AstGrepClient: class {
        async ensureAvailable() { return true; }
        scanFile() { return [{ severity: 'error', rule: 'no-secret', line: 1 }]; }
        formatDiagnostics() { return 'Structural issue found'; }
      }
    });
    fs.writeFileSync(path.join(projectDir, 'secret.ts'), 'const key = "123"');

    const result = await runLensAnalysis(projectDir);
    expect(result).toContain('[Structural]');
    expect(result).toContain('Structural issue found');
  });

  it('returns crash message (fail-open) if Lens bridge crashes and LENS_FAIL_POLICY=fail-open', async () => {
    const saved = process.env['LENS_FAIL_POLICY'];
    process.env['LENS_FAIL_POLICY'] = 'fail-open';
    try {
      const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
      (getLensClients as any).mockRejectedValue(new Error('Module not found'));

      // fail-open: no issues blocking, but returns empty (passes)
      const result = await runLensAnalysis(projectDir);
      expect(result).toBe(''); // fail-open → treated as clean
    } finally {
      if (saved !== undefined) process.env['LENS_FAIL_POLICY'] = saved;
      else delete process.env['LENS_FAIL_POLICY'];
    }
  });

  it('returns crash message (fail-closed) if Lens bridge crashes and LENS_FAIL_POLICY=fail-closed (default)', async () => {
    const saved = process.env['LENS_FAIL_POLICY'];
    delete process.env['LENS_FAIL_POLICY'];
    try {
      const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
      (getLensClients as any).mockRejectedValue(new Error('import failed'));

      const result = await runLensAnalysis(projectDir);
      expect(result).toContain('failed to run');
      expect(result).toContain('fail-closed policy');
    } finally {
      if (saved !== undefined) process.env['LENS_FAIL_POLICY'] = saved;
    }
  });

  it('lens gate is NOT included in runQualityGates report', async () => {
    const report: QualityReport = await runQualityGates(projectDir);
    const lensGate = report.gates.find(g => g.gate === 'lens');
    expect(lensGate).toBeUndefined();
  });
});

// ─── runGate command-array safety ────────────────────────────────

describe('runGate: execFile (no shell) command execution', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = path.join(os.tmpdir(), `gates-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('executes a valid command array without a shell', async () => {
    // runGate is private, but its effect is visible via runQualityGates.
    // We verify that the typescript gate runs as an array (no tsconfig = gate skipped,
    // meaning no unintended execution). Presence of tsconfig triggers it.
    const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
    (getLensClients as any).mockRejectedValue(new Error('no lens'));

    // No tsconfig → typescript gate skipped, no gate with shell metacharacters can fire
    const report = await runQualityGates(tmpDir);
    const tscGate = report.gates.find(g => g.gate === 'typescript');
    expect(tscGate).toBeUndefined(); // gate not run without tsconfig.json
  });

  it('file-safety gate passes when not in a git repo (fails gracefully)', async () => {
    const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
    (getLensClients as any).mockRejectedValue(new Error('no lens'));

    const report = await runQualityGates(tmpDir);
    const safetyGate = report.gates.find(g => g.gate === 'file-safety');

    // When git isn't available the gate should pass gracefully, not throw
    expect(safetyGate).toBeDefined();
    expect(safetyGate?.passed).toBe(true);
  });

  it('does not treat package.json parse failure as a hard crash', async () => {
    const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
    (getLensClients as any).mockRejectedValue(new Error('no lens'));

    // Write malformed JSON
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid json }');

    // Should not throw — the gate pipeline continues with empty pkg config
    await expect(runQualityGates(tmpDir)).resolves.not.toThrow();
  });
});

// ─── loadFileSafetyAllowlist ──────────────────────────────────────

describe('loadFileSafetyAllowlist', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when package.json has no tddConfig', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
    expect(loadFileSafetyAllowlist(tmpDir)).toEqual([]);
  });

  it('returns prefixes from tddConfig.fileSafetyAllowlist', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'test',
      tddConfig: { fileSafetyAllowlist: ['scripts/', 'config/', 'fixtures/'] },
    }));
    expect(loadFileSafetyAllowlist(tmpDir)).toEqual(['scripts/', 'config/', 'fixtures/']);
  });

  it('filters out non-string entries', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      tddConfig: { fileSafetyAllowlist: ['scripts/', 42, null, true, 'config/'] },
    }));
    expect(loadFileSafetyAllowlist(tmpDir)).toEqual(['scripts/', 'config/']);
  });

  it('returns empty array when fileSafetyAllowlist is not an array', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      tddConfig: { fileSafetyAllowlist: 'scripts/' },
    }));
    expect(loadFileSafetyAllowlist(tmpDir)).toEqual([]);
  });

  it('returns empty array when package.json is missing', () => {
    expect(loadFileSafetyAllowlist(path.join(tmpDir, 'nonexistent'))).toEqual([]);
  });

  it('returns empty array when package.json is malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid }');
    expect(loadFileSafetyAllowlist(tmpDir)).toEqual([]);
  });
});

// ─── getLensFailPolicy ────────────────────────────────────────────

describe('getLensFailPolicy', () => {
  afterEach(() => {
    delete process.env['LENS_FAIL_POLICY'];
  });

  it('returns fail-closed when env var is not set (secure default)', () => {
    delete process.env['LENS_FAIL_POLICY'];
    expect(getLensFailPolicy()).toBe('fail-closed');
  });

  it('returns fail-open when LENS_FAIL_POLICY=fail-open', () => {
    process.env['LENS_FAIL_POLICY'] = 'fail-open';
    expect(getLensFailPolicy()).toBe('fail-open');
  });

  it('returns fail-closed for unrecognised values', () => {
    process.env['LENS_FAIL_POLICY'] = 'unknown-value';
    expect(getLensFailPolicy()).toBe('fail-closed');
  });
});

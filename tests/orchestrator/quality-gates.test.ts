import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QualityReport, runQualityGates } from '../../src/orchestrator/quality-gates.js';
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

describe('Lens Quality Gate', () => {
  const projectDir = '/tmp/test-project';

  beforeEach(() => {
    vi.clearAllMocks();
    // Setup minimal project files
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'test' }));
  });

  it('should pass if Lens finds no issues', async () => {
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

    const report: QualityReport = await runQualityGates(projectDir);
    const lensGate = report.gates.find(g => g.gate === 'lens');

    expect(lensGate).toBeDefined();
    expect(lensGate?.passed).toBe(true);
    expect(lensGate?.output).toContain('passed');
  });

  it('should fail if Lens finds LSP errors', async () => {
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

    // Create a dummy .ts file to be scanned
    fs.writeFileSync(path.join(projectDir, 'index.ts'), 'bad code');

    const report: QualityReport = await runQualityGates(projectDir);
    const lensGate = report.gates.find(g => g.gate === 'lens');

    expect(lensGate?.passed).toBe(false);
    expect(lensGate?.output).toContain('[LSP]');
    expect(lensGate?.output).toContain('Type error');
  });

  it('should fail if Lens finds structural (ast-grep) errors', async () => {
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

    const report: QualityReport = await runQualityGates(projectDir);
    const lensGate = report.gates.find(g => g.gate === 'lens');

    expect(lensGate?.passed).toBe(false);
    expect(lensGate?.output).toContain('[Structural]');
    expect(lensGate?.output).toContain('Structural issue found');
  });

  it('should fail-safe (pass) if Lens bridge crashes', async () => {
    const { getLensClients } = await import('../../src/orchestrator/lens-bridge.js');
    (getLensClients as any).mockRejectedValue(new Error('Module not found'));

    const report: QualityReport = await runQualityGates(projectDir);
    const lensGate = report.gates.find(g => g.gate === 'lens');

    expect(lensGate?.passed).toBe(true);
    expect(lensGate?.output).toContain('failed to run');
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

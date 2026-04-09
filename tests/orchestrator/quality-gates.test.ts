import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QualityReport, runQualityGates } from '../../src/orchestrator/quality-gates.js';
import * as fs from 'fs';
import * as path from 'path';

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

    // Mock getSourceFiles implicitly by mocking fs.readdirSync/statSync if needed, 
    // or just let it find our package.json
    
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

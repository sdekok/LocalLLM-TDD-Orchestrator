import { describe, it, expect } from 'vitest';
import { formatGateFailures } from '../../src/orchestrator/quality-gates.js';
import type { QualityReport } from '../../src/orchestrator/quality-gates.js';

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

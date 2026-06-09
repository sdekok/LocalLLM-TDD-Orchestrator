import { describe, it, expect } from 'vitest';
import { parseReviewerVerdict } from '../../src/orchestrator/review-phase.js';
import { parseArbiterDecision, parseEscalationReply } from '../../src/orchestrator/arbiter-phase.js';
import { evaluateGateFailures } from '../../src/orchestrator/gate-evaluation.js';
import type { GateResult } from '../../src/orchestrator/quality-gates.js';

describe('parseReviewerVerdict', () => {
  it('parses an approval', () => {
    const v = parseReviewerVerdict('APPROVED: true\nSCORES: test_coverage=5\nFEEDBACK: looks good');
    expect(v.approved).toBe(true);
    expect(v.feedback).toBe('looks good');
  });

  it('parses a rejection with feedback', () => {
    const v = parseReviewerVerdict('APPROVED: false\nFEEDBACK: 1. Missing tests');
    expect(v.approved).toBe(false);
    expect(v.feedback).toContain('Missing tests');
  });

  it('falls back to a format warning when FEEDBACK is missing', () => {
    const v = parseReviewerVerdict('The code seems fine but I have concerns.');
    expect(v.approved).toBe(false);
    expect(v.feedback).toContain('did not follow the structured output format');
  });

  it('reports no output when text is empty', () => {
    const v = parseReviewerVerdict('');
    expect(v.approved).toBe(false);
    expect(v.feedback).toContain('produced no output');
  });
});

describe('parseArbiterDecision', () => {
  it('parses a continue decision with rounds', () => {
    const d = parseArbiterDecision('DECISION: continue\nROUNDS: 2\nRATIONALE: real progress');
    expect(d).toMatchObject({ decision: 'continue', rounds: 2, rationale: 'real progress', parsedOk: true });
  });

  it('defaults to escalate with parsedOk=false on garbage', () => {
    const d = parseArbiterDecision('I think we should keep going maybe?');
    expect(d.decision).toBe('escalate');
    expect(d.parsedOk).toBe(false);
  });
});

describe('parseEscalationReply', () => {
  it('parses approve', () => {
    expect(parseEscalationReply('approve')).toEqual({ action: 'approve', rounds: 0 });
  });
  it('parses continue N', () => {
    expect(parseEscalationReply('Continue 3')).toEqual({ action: 'continue', rounds: 3 });
  });
  it('treats null, empty, and unknown replies as stop', () => {
    expect(parseEscalationReply(null).action).toBe('stop');
    expect(parseEscalationReply('  ').action).toBe('stop');
    expect(parseEscalationReply('what?').action).toBe('stop');
  });
});

describe('evaluateGateFailures', () => {
  const gate = (name: string, passed: boolean, output = '', blocking = true): GateResult =>
    ({ gate: name, passed, blocking, output } as GateResult);

  it('ignores passing and non-blocking gates', () => {
    const r = evaluateGateFailures(
      [gate('build', true), gate('lint', false, 'warn', false)],
      new Map(),
    );
    expect(r.regressionGates).toHaveLength(0);
    expect(r.preexistingGates).toHaveLength(0);
  });

  it('treats a gate with no baseline as a full regression', () => {
    const r = evaluateGateFailures([gate('build', false, 'error TS2304: Cannot find name')], new Map());
    expect(r.regressionGates).toHaveLength(1);
    expect(r.regressionReports[0]).toContain('[BUILD BLOCKING]');
  });

  it('masks failures whose errors all exist in the baseline', () => {
    const output = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";
    const r = evaluateGateFailures(
      [gate('build', false, output)],
      new Map([['build', output]]),
    );
    expect(r.regressionGates).toHaveLength(0);
    expect(r.preexistingGates[0]).toContain('build');
  });
});

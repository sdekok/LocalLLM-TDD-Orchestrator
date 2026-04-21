/**
 * Unit tests for extractErrorSignatures and diffGateFailures — the per-gate
 * fingerprinting that lets the executor distinguish pre-existing baseline
 * failures from genuine regressions the implementer introduced.
 *
 * These tests are deliberately heavy on representative real-tool output
 * samples. If Vitest/TSC/ESLint change their output format, tests here break
 * first and tell us exactly which extractor to update.
 */
import { describe, it, expect } from 'vitest';
import { extractErrorSignatures, diffGateFailures } from '../../src/orchestrator/quality-gates.js';

describe('extractErrorSignatures — typescript', () => {
  const sample = [
    'src/foo.ts(12,34): error TS2345: Argument of type \'string\' is not assignable to parameter of type \'number\'.',
    'src/foo.ts(40,5): error TS2322: Type \'null\' is not assignable to type \'string\'.',
    'src/bar.tsx(1,1): error TS2307: Cannot find module \'./missing\'.',
    '',
    'Found 3 errors in 2 files.',
  ].join('\n');

  it('extracts one signature per distinct error (file + code + message)', () => {
    const sigs = extractErrorSignatures('typescript', sample);
    expect(sigs.size).toBe(3);
    expect(sigs.has('src/foo.ts:TS2345:Argument of type \'string\' is not assignable to parameter of type \'number\'.')).toBe(true);
    expect(sigs.has('src/foo.ts:TS2322:Type \'null\' is not assignable to type \'string\'.')).toBe(true);
    expect(sigs.has('src/bar.tsx:TS2307:Cannot find module \'./missing\'.')).toBe(true);
  });

  it('ignores line/column numbers so shifting code does not fake new errors', () => {
    const original = 'src/foo.ts(12,34): error TS2345: Argument mismatch.';
    const shifted = 'src/foo.ts(50,10): error TS2345: Argument mismatch.';
    const a = extractErrorSignatures('typescript', original);
    const b = extractErrorSignatures('typescript', shifted);
    expect([...a]).toEqual([...b]);
  });

  it('returns an empty set on empty output', () => {
    expect(extractErrorSignatures('typescript', '').size).toBe(0);
  });

  it('ignores non-error summary text', () => {
    const sigs = extractErrorSignatures('typescript', 'Found 3 errors in 2 files.\nError: something.');
    expect(sigs.size).toBe(0);
  });
});

describe('extractErrorSignatures — tests (vitest)', () => {
  const vitestSample = [
    '',
    'stderr | tests/foo.test.ts > Foo > fails',
    'Error: boom',
    '',
    ' FAIL  tests/foo.test.ts > Foo > fails  3ms',
    ' FAIL  tests/foo.test.ts > Foo > also fails',
    ' FAIL  tests/bar.test.ts > Bar > breaks',
    '',
    ' Test Files  2 failed (2)',
    '      Tests  3 failed | 5 passed (8)',
  ].join('\n');

  it('fingerprints per-case, not per-file (so two fails in one file → two signatures)', () => {
    const sigs = extractErrorSignatures('tests', vitestSample);
    expect(sigs.size).toBe(3);
    expect(sigs.has('tests/foo.test.ts > Foo > fails')).toBe(true);
    expect(sigs.has('tests/foo.test.ts > Foo > also fails')).toBe(true);
    expect(sigs.has('tests/bar.test.ts > Bar > breaks')).toBe(true);
  });

  it('strips trailing duration so the same test at a different speed is still the same signature', () => {
    const a = extractErrorSignatures('tests', ' FAIL  tests/foo.test.ts > Foo > slow  4ms');
    const b = extractErrorSignatures('tests', ' FAIL  tests/foo.test.ts > Foo > slow  1250ms');
    expect([...a]).toEqual([...b]);
  });

  it('ignores bare summary lines that coincidentally match the marker character', () => {
    const sigs = extractErrorSignatures('tests', '❯ Failed Tests 3\n× other random text');
    expect(sigs.size).toBe(0);
  });

  it('picks up per-case "×" marker lines too', () => {
    const sigs = extractErrorSignatures('tests', '  × tests/baz.test.ts > Baz > wobbles  12ms');
    expect(sigs.has('tests/baz.test.ts > Baz > wobbles')).toBe(true);
  });
});

describe('extractErrorSignatures — lint (eslint)', () => {
  const sample = [
    'src/auth.ts:12:5  error  Unexpected var  no-var',
    'src/auth.ts:14:10  warning  Prefer const  prefer-const',
    'src/user.ts:1:1  error  Missing semicolon  semi',
    '',
    '2 errors, 1 warning',
  ].join('\n');

  it('extracts one signature per error (file + message + rule), ignoring warnings', () => {
    const sigs = extractErrorSignatures('lint', sample);
    expect(sigs.size).toBe(2);
    expect(sigs.has('src/auth.ts:Unexpected var:no-var')).toBe(true);
    expect(sigs.has('src/user.ts:Missing semicolon:semi')).toBe(true);
  });

  it('ignores line and column numbers', () => {
    const a = extractErrorSignatures('lint', 'src/a.ts:10:5  error  X  rule-x');
    const b = extractErrorSignatures('lint', 'src/a.ts:50:1  error  X  rule-x');
    expect([...a]).toEqual([...b]);
  });
});

describe('extractErrorSignatures — lens', () => {
  const sample = [
    '[LSP] src/foo.ts: 2 error(s)',
    '  L12: Cannot find name \'x\'.',
    '  L40: Property \'y\' does not exist on type \'Z\'.',
    '[Structural] src/bar.ts:',
    '  Empty catch block detected',
  ].join('\n');

  it('fingerprints by file + message, dropping L-prefixed line numbers', () => {
    const sigs = extractErrorSignatures('lens', sample);
    expect(sigs.size).toBe(3);
    expect(sigs.has('src/foo.ts:Cannot find name \'x\'.')).toBe(true);
    expect(sigs.has('src/foo.ts:Property \'y\' does not exist on type \'Z\'.')).toBe(true);
    expect(sigs.has('src/bar.ts:Empty catch block detected')).toBe(true);
  });

  it('is stable across line-number shifts', () => {
    const a = extractErrorSignatures('lens', '[LSP] src/x.ts: 1 error(s)\n  L10: Bad thing');
    const b = extractErrorSignatures('lens', '[LSP] src/x.ts: 1 error(s)\n  L42: Bad thing');
    expect([...a]).toEqual([...b]);
  });

  it('falls back to raw line fingerprints for unstructured lens output', () => {
    const sigs = extractErrorSignatures('lens', 'custom warning 1\ncustom warning 2');
    expect(sigs.size).toBe(2);
  });
});

describe('extractErrorSignatures — file-safety', () => {
  const sample = [
    'Unexpected files outside standard directories:',
    'weird-thing.sh',
    'secrets.env',
  ].join('\n');

  it('extracts file paths from the list, not the header', () => {
    const sigs = extractErrorSignatures('file-safety', sample);
    expect(sigs.size).toBe(2);
    expect(sigs.has('weird-thing.sh')).toBe(true);
    expect(sigs.has('secrets.env')).toBe(true);
  });

  it('returns an empty set when the header is missing', () => {
    const sigs = extractErrorSignatures('file-safety', 'All files in expected locations');
    expect(sigs.size).toBe(0);
  });

  it('correctly diffs baseline vs current for file-safety (regression case)', () => {
    const baseline = 'Unexpected files outside standard directories:\nweird-thing.sh';
    const current = 'Unexpected files outside standard directories:\nweird-thing.sh\nevil-new.sh';
    const { newErrors } = diffGateFailures('file-safety', baseline, current);
    expect(newErrors).toEqual(['evil-new.sh']);
  });
});

describe('extractErrorSignatures — coverage / unknown', () => {
  it('returns empty set for coverage (callers short-circuit)', () => {
    expect(extractErrorSignatures('coverage', 'Lines: 50% < 80%').size).toBe(0);
  });

  it('uses generic "error|fail" line fingerprinting for unknown gates', () => {
    const sigs = extractErrorSignatures('custom-gate', 'ok\nerror: widget broke\nFAIL thing.js\nwarning: slow');
    expect(sigs.size).toBe(2);
    expect(sigs.has('error: widget broke')).toBe(true);
    expect(sigs.has('FAIL thing.js')).toBe(true);
  });
});

describe('diffGateFailures', () => {
  it('returns 0 new errors when current errors are a subset of baseline', () => {
    const baseline = 'src/a.ts(1,1): error TS1: old1\nsrc/a.ts(2,2): error TS2: old2';
    const current = 'src/a.ts(10,5): error TS1: old1';
    const { newErrors } = diffGateFailures('typescript', baseline, current);
    expect(newErrors).toEqual([]);
  });

  it('returns only the newly-introduced errors', () => {
    const baseline = 'src/a.ts(1,1): error TS1: old1';
    const current = 'src/a.ts(1,1): error TS1: old1\nsrc/b.ts(3,3): error TS2: new err';
    const { newErrors } = diffGateFailures('typescript', baseline, current);
    expect(newErrors).toEqual(['src/b.ts:TS2:new err']);
  });

  it('reports baselineCount and currentCount for logging context', () => {
    const baseline = 'src/a.ts(1,1): error TS1: one\nsrc/b.ts(2,2): error TS2: two';
    const current = 'src/c.ts(3,3): error TS3: three';
    const { baselineCount, currentCount } = diffGateFailures('typescript', baseline, current);
    expect(baselineCount).toBe(2);
    expect(currentCount).toBe(1);
  });

  it('detects regressions in the tests gate at the case level (same file, new case)', () => {
    const baseline = ' FAIL  tests/a.test.ts > A > one';
    const current = ' FAIL  tests/a.test.ts > A > one\n FAIL  tests/a.test.ts > A > two';
    const { newErrors } = diffGateFailures('tests', baseline, current);
    expect(newErrors).toEqual(['tests/a.test.ts > A > two']);
  });

  it('detects regressions in the lens gate when a new issue appears', () => {
    const baseline = '[LSP] src/a.ts: 1 error(s)\n  L10: old message';
    const current = '[LSP] src/a.ts: 1 error(s)\n  L10: old message\n  L20: new issue';
    const { newErrors } = diffGateFailures('lens', baseline, current);
    expect(newErrors).toEqual(['src/a.ts:new issue']);
  });
});

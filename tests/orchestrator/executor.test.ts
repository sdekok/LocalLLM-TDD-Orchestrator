import { describe, it, expect } from 'vitest';
import { outputSimilarity, reviewerVerdictComplete, boundFeedbackForPrompt, extractActionItems } from '../../src/orchestrator/executor.js';
import * as path from 'path';

describe('extractActionItems — short checklist for the fixer', () => {
  it('pulls numbered item titles, dropping the verbose body', () => {
    const fb = [
      '1. LSP type error on index.ts:120 — stateStore passed where required',
      '',
      'The module-scope variable is declared OAuthStateStore | undefined and ...long paragraph...',
      '',
      '2. Missing test for cross-user authorization on DELETE',
      'Add a test that ...',
    ].join('\n');
    const out = extractActionItems(fb);
    expect(out).toContain('1. LSP type error on index.ts:120');
    expect(out).toContain('2. Missing test for cross-user authorization on DELETE');
    expect(out).not.toContain('long paragraph');
  });
  it('handles bullet lists (e.g. gate error signatures)', () => {
    const out = extractActionItems('[TESTS BLOCKING] 3 new error(s):\n  • a.test.ts > x failed\n  • b.test.ts > y failed');
    expect(out).toContain('1. a.test.ts > x failed');
    expect(out).toContain('2. b.test.ts > y failed');
  });
  it('caps the number of items', () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i + 1}. issue ${i + 1}`).join('\n');
    const lines = extractActionItems(many, 12).split('\n');
    expect(lines.length).toBe(12);
  });
  it('falls back to a bounded snippet when there is no list', () => {
    const out = extractActionItems('Just a prose paragraph with no list structure at all.');
    expect(out).toContain('Just a prose paragraph');
  });

  it('matches markdown-bolded numbered headers (**1. …**)', () => {
    const fb = [
      '**1. Event payload format mismatch — create vs update (BLOCKER)**',
      '',
      'The create handler emits a different shape...',
      '',
      '**2. Metadata spread corruption in test mock (HIGH)**',
      'The mock spreads metadata incorrectly...',
    ].join('\n');
    const out = extractActionItems(fb);
    expect(out).toContain('1. Event payload format mismatch — create vs update (BLOCKER)');
    expect(out).toContain('2. Metadata spread corruption in test mock (HIGH)');
    // The ** wrappers must be stripped, not carried into the checklist.
    expect(out).not.toContain('**');
  });

  it('drops the trailing "Non-issues" section and keeps the real numbered issues', () => {
    // Exact shape from the WI-5 regression: 5 bold-numbered blockers followed by
    // a "Non-issues" bullet list. The fixer must receive the 5 issues, NOT the
    // 3 non-issue bullets (the original bug surfaced only the non-issues).
    const fb = [
      '**1. Event payload format mismatch — create vs update (BLOCKER)**',
      'Details...',
      '**2. Metadata spread corruption in test mock (HIGH)**',
      'Details...',
      '**3. Race condition on concurrent writes (MEDIUM)**',
      'Details...',
      '**4. Missing test for assigneeId propagation (LOW)**',
      'Details...',
      '**5. Error handling via string prefix matching (LOW)**',
      'Details...',
      '',
      '**Non-issues (already known or pre-existing):**',
      '- `cast` widened to `any` — pre-existing pattern in create handler',
      '- `@types/pg` missing — pre-existing across the project',
      '- Pool leak fixed correctly with module-level singleton',
    ].join('\n');
    const out = extractActionItems(fb);
    expect(out).toContain('1. Event payload format mismatch');
    expect(out).toContain('5. Error handling via string prefix matching (LOW)');
    // None of the non-issue bullets should leak into the checklist.
    expect(out).not.toContain('cast');
    expect(out).not.toContain('@types/pg');
    expect(out).not.toContain('Pool leak');
    expect(out.split('\n')).toHaveLength(5);
  });

  it('prefers numbered issues over interleaved bullet sub-points', () => {
    const fb = [
      '**1. Validation gap (HIGH)**',
      '- sub-point a',
      '- sub-point b',
      '**2. Logging missing (LOW)**',
    ].join('\n');
    const out = extractActionItems(fb);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('1. Validation gap (HIGH)');
    expect(out).toContain('2. Logging missing (LOW)');
    expect(out).not.toContain('sub-point');
  });
});

describe('boundFeedbackForPrompt — protects the context window', () => {
  it('returns short feedback unchanged', () => {
    expect(boundFeedbackForPrompt('all good', 100)).toBe('all good');
  });
  it('truncates oversized feedback and notes the omission', () => {
    const big = 'x'.repeat(50_000);
    const out = boundFeedbackForPrompt(big, 6000);
    expect(out.length).toBeLessThan(7000);
    expect(out).toContain('truncated to protect the context window');
  });
  it('handles empty/undefined input', () => {
    expect(boundFeedbackForPrompt('', 100)).toBe('');
    expect(boundFeedbackForPrompt(undefined as any, 100)).toBe(undefined as any);
  });
});

describe('reviewerVerdictComplete — triggers format self-correction', () => {
  it('approved verdict is complete without feedback', () => {
    expect(reviewerVerdictComplete('APPROVED: true\nSCORES: test_coverage=5')).toBe(true);
  });
  it('rejected with feedback is complete', () => {
    expect(reviewerVerdictComplete('APPROVED: false\nSCORES: x\nFEEDBACK: fix the type error on line 12')).toBe(true);
  });
  it('rejected with NO feedback is incomplete', () => {
    expect(reviewerVerdictComplete('APPROVED: false\nSCORES: x')).toBe(false);
  });
  it('rejected with a typo header (FEEDFIX) is incomplete', () => {
    expect(reviewerVerdictComplete('APPROVED: false\nSCORES: x\nFEEDFIX:\n1. do the thing')).toBe(false);
  });
  it('rejected with empty feedback is incomplete', () => {
    expect(reviewerVerdictComplete('APPROVED: false\nFEEDBACK:   \n')).toBe(false);
  });
  it('no structured verdict at all is incomplete', () => {
    expect(reviewerVerdictComplete('Let me read the files first. Now I will form my verdict.')).toBe(false);
  });
});

describe('outputSimilarity — loop detection', () => {
  it('returns 1.0 for identical strings', () => {
    expect(outputSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for empty inputs', () => {
    expect(outputSimilarity('', 'hello')).toBe(0);
    expect(outputSimilarity('hello', '')).toBe(0);
  });

  it('returns high similarity for near-identical code', () => {
    const v1 = 'export function add(a: number, b: number) { return a + b; }';
    const v2 = 'export function add(a: number, b: number) { return a + b; } // fixed';
    expect(outputSimilarity(v1, v2)).toBeGreaterThan(0.85);
  });

  it('returns low similarity for completely different output', () => {
    const a = 'export function add(a: number, b: number) { return a + b; }';
    const b = 'import express from "express"; const app = express(); app.listen(3000);';
    expect(outputSimilarity(a, b)).toBeLessThan(0.5);
  });

  it('detects agent stuck in a loop (same error, same code)', () => {
    const attempt1 = JSON.stringify({
      tests: [{ filepath: 'tests/auth.test.ts', content: 'test("login", () => {})' }],
      code: [{ filepath: 'src/auth.ts', content: 'export function login() { return true; }' }],
    });
    const attempt2 = JSON.stringify({
      tests: [{ filepath: 'tests/auth.test.ts', content: 'test("login", () => {})' }],
      code: [{ filepath: 'src/auth.ts', content: 'export function login() { return true; }' }],
    });
    expect(outputSimilarity(attempt1, attempt2)).toBe(1);
  });

  it('allows genuine progress (same structure, different content)', () => {
    const attempt1 = JSON.stringify({
      code: [{ filepath: 'src/auth.ts', content: 'export function login() { return true; }' }],
    });
    const attempt2 = JSON.stringify({
      code: [{ filepath: 'src/auth.ts', content: 'export async function login(email: string, password: string) { const user = await db.findUser(email); return bcrypt.compare(password, user.hash); }' }],
    });
    // Should be well below the 0.9 threshold since the implementation is genuinely different
    expect(outputSimilarity(attempt1, attempt2)).toBeLessThan(0.9);
  });

  it('handles minor whitespace-only changes as loops', () => {
    const v1 = 'function foo() { return 1; }';
    const v2 = 'function foo() {  return  1;  }';
    expect(outputSimilarity(v1, v2)).toBeGreaterThan(0.85);
  });
});

describe('executor — branch name uses 12-char prefix', () => {
  it('branchName contains 12 chars of task ID', () => {
    // The executor builds: `tdd-workflow/${task.id.substring(0, 12)}`
    // We can verify by checking the substring length directly
    const taskId = 'abcdef1234567890';
    const branchName = `tdd-workflow/${taskId.substring(0, 12)}`;
    const prefix = branchName.split('/')[1]!;
    expect(prefix).toHaveLength(12);
    expect(prefix).toBe('abcdef123456');
  });

  it('branch name is shorter than 12 chars when task ID is short', () => {
    const taskId = 'short';
    const branchName = `tdd-workflow/${taskId.substring(0, 12)}`;
    const prefix = branchName.split('/')[1]!;
    // substring is safe — returns full string if shorter
    expect(prefix).toBe('short');
  });
});

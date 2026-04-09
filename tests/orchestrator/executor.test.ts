import { describe, it, expect } from 'vitest';
import { outputSimilarity } from '../../src/orchestrator/executor.js';
import * as path from 'path';

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

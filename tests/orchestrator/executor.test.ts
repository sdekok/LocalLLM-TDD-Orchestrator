import { describe, it, expect } from 'vitest';
import { outputSimilarity } from '../../src/orchestrator/executor.js';

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

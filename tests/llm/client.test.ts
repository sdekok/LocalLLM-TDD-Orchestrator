import { describe, it, expect } from 'vitest';
import { extractJSON, makeCacheKey } from '../../src/llm/client.js';

describe('extractJSON', () => {
  it('parses clean JSON directly', () => {
    const result = extractJSON<{ name: string }>('{"name": "test"}');
    expect(result.name).toBe('test');
  });

  it('extracts JSON from prose with leading text', () => {
    const raw = 'Here is the JSON output:\n{"name": "test", "value": 42}';
    const result = extractJSON<{ name: string; value: number }>(raw);
    expect(result.name).toBe('test');
    expect(result.value).toBe(42);
  });

  it('extracts JSON from prose with trailing text', () => {
    const raw = '{"name": "test"}\nI hope this helps!';
    const result = extractJSON<{ name: string }>(raw);
    expect(result.name).toBe('test');
  });

  it('extracts JSON from markdown code blocks', () => {
    const raw = '```json\n{"name": "test"}\n```';
    const result = extractJSON<{ name: string }>(raw);
    expect(result.name).toBe('test');
  });

  it('handles trailing commas via JSON5', () => {
    const raw = '{"items": ["a", "b",], "count": 2,}';
    const result = extractJSON<{ items: string[]; count: number }>(raw);
    expect(result.items).toEqual(['a', 'b']);
    expect(result.count).toBe(2);
  });

  it('handles single quotes via JSON5', () => {
    const raw = "{'name': 'test'}";
    const result = extractJSON<{ name: string }>(raw);
    expect(result.name).toBe('test');
  });

  it('handles comments in JSON via JSON5', () => {
    const raw = '{\n  // This is a comment\n  "name": "test"\n}';
    const result = extractJSON<{ name: string }>(raw);
    expect(result.name).toBe('test');
  });

  it('extracts nested objects surrounded by text', () => {
    const raw = 'Sure, here you go:\n\n{"refinedRequest": "Do X", "subtasks": [{"description": "Step 1"}]}\n\nLet me know if you need changes.';
    const result = extractJSON<{ refinedRequest: string; subtasks: { description: string }[] }>(raw);
    expect(result.refinedRequest).toBe('Do X');
    expect(result.subtasks).toHaveLength(1);
  });

  it('throws on completely invalid input', () => {
    expect(() => extractJSON('not json at all')).toThrow('Could not extract valid JSON');
  });

  it('throws on truncated JSON', () => {
    expect(() => extractJSON('{"name": "test')).toThrow('Could not extract valid JSON');
  });
});

// ─── makeCacheKey ──────────────────────────────────────────────────

describe('makeCacheKey', () => {
  it('does not include the raw API key in the cache key', () => {
    const key = makeCacheKey('http://localhost:8080/v1', 'sk-my-secret-api-key');
    expect(key).not.toContain('sk-my-secret-api-key');
    expect(key).toContain('http://localhost:8080/v1::');
  });

  it('produces the same key for identical inputs (deterministic)', () => {
    const k1 = makeCacheKey('http://localhost', 'sk-test');
    const k2 = makeCacheKey('http://localhost', 'sk-test');
    expect(k1).toBe(k2);
  });

  it('produces different keys for different API keys', () => {
    const k1 = makeCacheKey('http://localhost', 'sk-key1');
    const k2 = makeCacheKey('http://localhost', 'sk-key2');
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different base URLs', () => {
    const k1 = makeCacheKey('http://host-a', 'sk-same');
    const k2 = makeCacheKey('http://host-b', 'sk-same');
    expect(k1).not.toBe(k2);
  });

  it('hash segment is exactly 16 hex characters', () => {
    const key = makeCacheKey('http://localhost', 'sk-test');
    const hashPart = key.split('::')[1];
    expect(hashPart).toMatch(/^[0-9a-f]{16}$/);
  });
});

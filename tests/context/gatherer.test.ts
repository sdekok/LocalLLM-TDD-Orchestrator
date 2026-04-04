import { describe, it, expect } from 'vitest';
import { extractKeywords, detectFramework, detectTestFramework } from '../../src/context/gatherer.js';

describe('extractKeywords', () => {
  it('extracts meaningful words', () => {
    const keywords = extractKeywords('Build a JWT authentication middleware for Express');
    expect(keywords).toContain('jwt');
    expect(keywords).toContain('authentication');
    expect(keywords).toContain('middleware');
    expect(keywords).toContain('express');
  });

  it('filters out stop words', () => {
    const keywords = extractKeywords('Create a new function to handle the request');
    expect(keywords).not.toContain('create');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('new');
    expect(keywords).toContain('function');
    expect(keywords).toContain('handle');
    expect(keywords).toContain('request');
  });

  it('deduplicates keywords', () => {
    const keywords = extractKeywords('test the test for testing');
    const testCount = keywords.filter((k) => k === 'test').length;
    expect(testCount).toBeLessThanOrEqual(1);
  });

  it('removes short words', () => {
    const keywords = extractKeywords('do it or be');
    expect(keywords).toHaveLength(0);
  });
});

describe('detectFramework', () => {
  it('detects Express', () => {
    expect(detectFramework({ express: '4.18.0' })).toBe('express');
  });

  it('detects Next.js', () => {
    expect(detectFramework({ next: '14.0.0' })).toBe('next');
  });

  it('detects NestJS', () => {
    expect(detectFramework({ '@nestjs/core': '10.0.0' })).toBe('nestjs');
  });

  it('returns null when no framework found', () => {
    expect(detectFramework({ lodash: '4.17.0' })).toBeNull();
  });
});

describe('detectTestFramework', () => {
  it('detects vitest', () => {
    expect(detectTestFramework({ vitest: '1.0.0' })).toBe('vitest');
  });

  it('detects jest', () => {
    expect(detectTestFramework({ jest: '29.0.0' })).toBe('jest');
  });

  it('detects mocha', () => {
    expect(detectTestFramework({ mocha: '10.0.0' })).toBe('mocha');
  });

  it('returns unknown when no test framework found', () => {
    expect(detectTestFramework({ lodash: '4.17.0' })).toBe('unknown');
  });
});

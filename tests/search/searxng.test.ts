import { describe, it, expect } from 'vitest';
import { stripHTML, hasExternalDependencies, shouldSearch } from '../../src/search/searxng.js';

describe('stripHTML', () => {
  it('removes script tags', () => {
    const html = '<p>Hello</p><script>alert("xss")</script><p>World</p>';
    expect(stripHTML(html)).toBe('Hello World');
  });

  it('removes style tags', () => {
    const html = '<style>.fancy{color:red}</style><p>Content</p>';
    expect(stripHTML(html)).toBe('Content');
  });

  it('removes all HTML tags', () => {
    const html = '<div class="test"><span>Text</span></div>';
    expect(stripHTML(html)).toBe('Text');
  });

  it('collapses whitespace', () => {
    const html = '<p>Hello</p>   \n\n   <p>World</p>';
    expect(stripHTML(html)).toBe('Hello World');
  });

  it('handles empty input', () => {
    expect(stripHTML('')).toBe('');
  });
});

describe('hasExternalDependencies', () => {
  it('detects Express', () => {
    expect(hasExternalDependencies('Build an Express middleware')).toBe(true);
  });

  it('detects JWT', () => {
    expect(hasExternalDependencies('Validate JWT tokens')).toBe(true);
  });

  it('detects cloud providers', () => {
    expect(hasExternalDependencies('Deploy to AWS Lambda')).toBe(true);
  });

  it('detects API keyword', () => {
    expect(hasExternalDependencies('Create a REST API endpoint')).toBe(true);
  });

  it('returns false for simple refactoring', () => {
    expect(hasExternalDependencies('Rename the variable foo to bar')).toBe(false);
  });

  it('returns false for generic descriptions', () => {
    expect(hasExternalDependencies('add a function that returns hello')).toBe(false);
  });
});

describe('shouldSearch', () => {
  it('searches on first attempt with external deps', () => {
    expect(shouldSearch('Build JWT auth middleware', 1)).toBe(true);
  });

  it('does not search for refactoring tasks', () => {
    expect(shouldSearch('Refactor the auth module', 1)).toBe(false);
  });

  it('searches on retry when feedback mentions unknown API', () => {
    expect(shouldSearch('some task', 2, 'Error: unknown function not found')).toBe(true);
  });

  it('does not search on first attempt without external deps', () => {
    expect(shouldSearch('add a helper function', 1)).toBe(false);
  });
});

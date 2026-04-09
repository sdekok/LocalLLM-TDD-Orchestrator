import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripHTML, hasExternalDependencies, shouldSearch, SearchClient } from '../../src/search/searxng.js';

// Mock the URL validator so we control which URLs are allowed/blocked
// without real DNS lookups in unit tests.
vi.mock('../../src/utils/url-validator.js', () => ({
  validateExternalUrl: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { validateExternalUrl } from '../../src/utils/url-validator.js';

// ─── stripHTML ────────────────────────────────────────────────────

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

// ─── hasExternalDependencies ──────────────────────────────────────

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

// ─── shouldSearch ─────────────────────────────────────────────────

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

// ─── SearchClient.searchAndSummarize — SSRF protection ───────────

describe('SearchClient.searchAndSummarize — SSRF protection', () => {
  let client: SearchClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SearchClient('http://localhost:8888');
  });

  function mockSearchResponse(results: { title: string; url: string; content: string }[]) {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results, number_of_results: results.length, query: 'test' }),
    }) as any;
  }

  it('calls validateExternalUrl for each result URL', async () => {
    vi.mocked(validateExternalUrl).mockResolvedValue(new URL('https://example.com') as any);
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Page 1', url: 'https://example.com/1', content: 'snippet1', engine: 'google' },
            { title: 'Page 2', url: 'https://example.com/2', content: 'snippet2', engine: 'google' },
          ],
          number_of_results: 2,
          query: 'test',
        }),
      })
      // Second and third calls are page fetches
      .mockResolvedValue({ ok: true, text: async () => '<p>content</p>' }) as any;

    await client.searchAndSummarize('test query', 2);

    expect(validateExternalUrl).toHaveBeenCalledWith('https://example.com/1');
    expect(validateExternalUrl).toHaveBeenCalledWith('https://example.com/2');
  });

  it('falls back to snippet when validateExternalUrl blocks a URL', async () => {
    vi.mocked(validateExternalUrl).mockRejectedValue(new Error('Blocked private IPv4 address: 192.168.1.1'));

    mockSearchResponse([
      { title: 'Internal Server', url: 'http://192.168.1.1/admin', content: 'the snippet fallback' },
    ]);

    const result = await client.searchAndSummarize('test', 1);

    // The page fetch should never be called for the blocked URL
    expect(global.fetch).toHaveBeenCalledTimes(1); // only the search call
    // Falls back to the snippet text, not the page content
    expect(result).toContain('the snippet fallback');
    expect(result).toContain('Internal Server');
  });

  it('falls back to snippet when validateExternalUrl blocks a localhost URL', async () => {
    vi.mocked(validateExternalUrl).mockRejectedValue(new Error('Blocked internal hostname: localhost'));

    mockSearchResponse([
      { title: 'Local Admin', url: 'http://localhost:9200/', content: 'elasticsearch snippet' },
    ]);

    const result = await client.searchAndSummarize('test', 1);

    expect(global.fetch).toHaveBeenCalledTimes(1); // only the search call
    expect(result).toContain('elasticsearch snippet');
  });

  it('fetches the page when URL passes validation', async () => {
    vi.mocked(validateExternalUrl).mockResolvedValue(new URL('https://docs.example.com') as any);

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ title: 'Docs', url: 'https://docs.example.com/guide', content: 'fallback', engine: 'google' }],
          number_of_results: 1,
          query: 'test',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<p>Full page content here</p>',
      }) as any;

    const result = await client.searchAndSummarize('test', 1);

    expect(global.fetch).toHaveBeenCalledTimes(2); // search + page fetch
    expect(result).toContain('Full page content here');
  });

  it('uses the SEARXNG_URL env var when no baseURL is passed to constructor', () => {
    const original = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = 'http://my-searxng:9000';
    const c = new SearchClient();
    expect((c as any).baseURL).toBe('http://my-searxng:9000');
    process.env.SEARXNG_URL = original;
  });

  it('falls back to localhost:8888 when no baseURL or env var', () => {
    const original = process.env.SEARXNG_URL;
    delete process.env.SEARXNG_URL;
    const c = new SearchClient();
    expect((c as any).baseURL).toBe('http://localhost:8888');
    process.env.SEARXNG_URL = original;
  });
});

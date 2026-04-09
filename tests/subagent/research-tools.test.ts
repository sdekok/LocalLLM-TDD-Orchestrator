import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTools } from '../../src/subagent/research-tools.js';

// Mock url-validator so we control which URLs are allowed/blocked without
// real DNS lookups, and so we can assert it was called.
vi.mock('../../src/utils/url-validator.js', () => ({
  validateExternalUrl: vi.fn(),
}));

vi.mock('youtube-transcript/dist/youtube-transcript.esm.js', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn().mockResolvedValue([
      { text: 'Hello' },
      { text: 'World' }
    ])
  }
}));

// Mock global fetch
global.fetch = vi.fn() as any;

import { validateExternalUrl } from '../../src/utils/url-validator.js';

describe('Research Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all URLs pass validation
    vi.mocked(validateExternalUrl).mockResolvedValue(new URL('https://example.com') as any);
  });

  // ─── Tool registry ─────────────────────────────────────────────

  it('provides the correct tools', () => {
    const tools = createResearchTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('fetch_and_convert_html');
    expect(tools[1]!.name).toBe('parse_youtube_transcript');
  });

  // ─── fetch_and_convert_html: existing behaviour ────────────────

  it('fetch_and_convert_html handles failed fetch', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;

    (global.fetch as any).mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      headers: { get: () => null },
    });

    const result = await fetchHTML.execute('call_1', { url: 'https://bad.url' }, undefined, undefined, {} as any);
    expect((result.content[0] as any).text).toContain('Failed to fetch URL: Not Found');
  });

  it('fetch_and_convert_html converts successful fetch', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => '<html><head><title>My Article</title></head><body><h1>My Article</h1><p>Important text</p></body></html>'
    });

    const result = await fetchHTML.execute('call_1', { url: 'https://good.url' }, undefined, undefined, {} as any);
    expect((result.content[0] as any).text).toContain('# My Article');
    expect((result.content[0] as any).text).toContain('Important text');
  });

  // ─── fetch_and_convert_html: SSRF protection ──────────────────

  it('calls validateExternalUrl before fetching', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => '<html><body><p>content</p></body></html>',
    });

    await fetchHTML.execute('call_1', { url: 'https://example.com/page' }, undefined, undefined, {} as any);

    expect(validateExternalUrl).toHaveBeenCalledWith('https://example.com/page');
  });

  it('blocks SSRF: returns error text when URL is an internal address', async () => {
    vi.mocked(validateExternalUrl).mockRejectedValue(
      new Error('Blocked private IPv4 address: 192.168.1.1')
    );

    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;

    const result = await fetchHTML.execute('call_1', { url: 'http://192.168.1.1/admin' }, undefined, undefined, {} as any);

    // fetch should NOT have been called
    expect(global.fetch).not.toHaveBeenCalled();
    // Error message is returned as tool output (not a thrown exception)
    expect((result.content[0] as any).text).toContain('Error fetching or converting HTML');
    expect((result.content[0] as any).text).toContain('Blocked private IPv4 address');
  });

  it('blocks SSRF: localhost is rejected before fetch is called', async () => {
    vi.mocked(validateExternalUrl).mockRejectedValue(
      new Error('Blocked internal hostname: localhost')
    );

    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;

    const result = await fetchHTML.execute('call_1', { url: 'http://localhost:3000/api/secret' }, undefined, undefined, {} as any);

    expect(global.fetch).not.toHaveBeenCalled();
    expect((result.content[0] as any).text).toContain('Blocked internal hostname');
  });

  it('blocks SSRF: cloud metadata endpoint is rejected', async () => {
    vi.mocked(validateExternalUrl).mockRejectedValue(
      new Error('Blocked internal hostname: 169.254.169.254')
    );

    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;

    const result = await fetchHTML.execute('call_1', { url: 'http://169.254.169.254/latest/meta-data/' }, undefined, undefined, {} as any);

    expect(global.fetch).not.toHaveBeenCalled();
    expect((result.content[0] as any).text).toContain('169.254.169.254');
  });

  // ─── fetch_and_convert_html: size limits ──────────────────────

  it('blocks responses that declare a large content-length', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;
    const OVER_LIMIT = (5 * 1024 * 1024 + 1).toString();

    (global.fetch as any).mockResolvedValue({
      ok: true,
      headers: { get: (name: string) => name === 'content-length' ? OVER_LIMIT : null },
      text: async () => 'x'.repeat(1000),
    });

    const result = await fetchHTML.execute('call_1', { url: 'https://huge.example.com/' }, undefined, undefined, {} as any);

    expect((result.content[0] as any).text).toContain('too large');
  });

  it('blocks responses whose body exceeds the size limit (no content-length header)', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;
    const bigBody = 'x'.repeat(5 * 1024 * 1024 + 1);

    (global.fetch as any).mockResolvedValue({
      ok: true,
      headers: { get: () => null }, // no content-length declared
      text: async () => bigBody,
    });

    const result = await fetchHTML.execute('call_1', { url: 'https://huge.example.com/' }, undefined, undefined, {} as any);

    expect((result.content[0] as any).text).toContain('too large');
  });

  it('allows responses within the size limit', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;

    (global.fetch as any).mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      text: async () => '<html><body><p>Normal sized content</p></body></html>',
    });

    const result = await fetchHTML.execute('call_1', { url: 'https://example.com/article' }, undefined, undefined, {} as any);

    expect((result.content[0] as any).text).not.toContain('too large');
  });

  // ─── parse_youtube_transcript: existing behaviour ──────────────

  it('parse_youtube_transcript fetches words', async () => {
    const tools = createResearchTools();
    const parseYT = tools.find(t => t.name === 'parse_youtube_transcript')!;

    const result = await parseYT.execute('call_1', { url: 'https://youtube.com/watch?v=123' }, undefined, undefined, {} as any);
    expect((result.content[0] as any).text).toBe('Hello World');
  });
});

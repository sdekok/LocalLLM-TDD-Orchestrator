import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createResearchTools } from '../../src/subagent/research-tools.js';

// Mock dependencies
const mockFetchUrl = vi.fn();
vi.mock('youtube-transcript', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn().mockResolvedValue([
      { text: 'Hello' },
      { text: 'World' }
    ])
  }
}));

// Mock global fetch
global.fetch = vi.fn() as any;

describe('Research Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provides the correct tools', () => {
    const tools = createResearchTools();
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe('fetch_and_convert_html');
    expect(tools[1]!.name).toBe('parse_youtube_transcript');
  });

  it('fetch_and_convert_html handles failed fetch', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;
    
    (global.fetch as any).mockResolvedValue({
      ok: false,
      statusText: 'Not Found'
    });

    const result = await fetchHTML.execute('call_1', { url: 'https://bad.url' }, undefined, undefined, {} as any);
    expect((result.content[0] as any).text).toContain('Failed to fetch URL: Not Found');
  });

  it('fetch_and_convert_html converts successful fetch', async () => {
    const tools = createResearchTools();
    const fetchHTML = tools.find(t => t.name === 'fetch_and_convert_html')!;
    
    (global.fetch as any).mockResolvedValue({
      ok: true,
      text: async () => '<html><head><title>My Article</title></head><body><h1>My Article</h1><p>Important text</p></body></html>'
    });

    const result = await fetchHTML.execute('call_1', { url: 'https://good.url' }, undefined, undefined, {} as any);
    expect((result.content[0] as any).text).toContain('# My Article');
    expect((result.content[0] as any).text).toContain('Important text');
  });

  it('parse_youtube_transcript fetches words', async () => {
    const tools = createResearchTools();
    const parseYT = tools.find(t => t.name === 'parse_youtube_transcript')!;

    const result = await parseYT.execute('call_1', { url: 'https://youtube.com/watch?v=123' }, undefined, undefined, {} as any);
    expect((result.content[0] as any).text).toBe('Hello World');
  });
});

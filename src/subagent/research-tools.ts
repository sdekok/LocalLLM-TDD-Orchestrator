import { Type } from 'typebox';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
// @ts-expect-error - Importing ESM dist directly for bundle compatibility
import * as yt from 'youtube-transcript/dist/youtube-transcript.esm.js';
const YoutubeTranscript = yt.YoutubeTranscript;
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { validateExternalUrl } from '../utils/url-validator.js';

// HTML parsing tool schema
export const FetchAndConvertHtmlSchema = Type.Object({
  url: Type.String({ description: "The URL of the webpage or documentation to fetch and read." }),
});

export type FetchAndConvertHtmlArgs = {
  url: string;
};

// YouTube parsing tool schema
export const ParseYoutubeTranscriptSchema = Type.Object({
  url: Type.String({ description: "The YouTube video URL to fetch the transcript for." }),
});

export type ParseYoutubeTranscriptArgs = {
  url: string;
};

/** Maximum response body size for fetched pages (5 MB). */
const MAX_FETCH_SIZE = 5 * 1024 * 1024;

export function createResearchTools(): ToolDefinition[] {
  return [
    {
      name: 'fetch_and_convert_html',
      label: 'Fetch and Convert HTML to Markdown',
      description: 'Fetches a URL, extracts the main article content (stripping ads and navbars), and converts it into readable Markdown.',
      parameters: FetchAndConvertHtmlSchema,
      execute: async (toolCallId: string, params: FetchAndConvertHtmlArgs) => {
        try {
          // Block SSRF: reject internal/private network URLs before fetching.
          await validateExternalUrl(params.url);

          const response = await fetch(params.url, {
            signal: AbortSignal.timeout(15_000),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TDDWorkflow/1.0)' },
          });

          if (!response.ok) {
            return { content: [{ type: 'text', text: `Failed to fetch URL: ${response.statusText}` }], details: {} };
          }

          // Guard against large responses: check declared content-length first.
          const contentLength = parseInt(response.headers?.get?.('content-length') ?? '0', 10);
          if (contentLength > MAX_FETCH_SIZE) {
            return { content: [{ type: 'text', text: `Response too large (${contentLength} bytes). Maximum allowed: ${MAX_FETCH_SIZE} bytes.` }], details: {} };
          }

          const html = await response.text();

          // Guard against large responses that omitted content-length.
          if (html.length > MAX_FETCH_SIZE) {
            return { content: [{ type: 'text', text: `Response body too large (${html.length} bytes). Maximum allowed: ${MAX_FETCH_SIZE} bytes.` }], details: {} };
          }

          const dom = new JSDOM(html, { url: params.url });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();

          if (!article || !article.content) {
            return { content: [{ type: 'text', text: 'Could not extract article content from the specified URL.' }], details: {} };
          }

          const turndownService = new TurndownService({ headingStyle: 'atx' });
          const markdown = turndownService.turndown(article.content);

          return { content: [{ type: 'text', text: `# ${article.title}\n\n${markdown}` }], details: {} };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error fetching or converting HTML: ${(error as Error).message}` }], details: {} };
        }
      }
    },
    {
      name: 'parse_youtube_transcript',
      label: 'Parse YouTube Transcript',
      description: 'Extracts the closed captions/transcript from a YouTube video URL.',
      parameters: ParseYoutubeTranscriptSchema,
      execute: async (toolCallId: string, params: ParseYoutubeTranscriptArgs) => {
        try {
          const transcriptItems = await YoutubeTranscript.fetchTranscript(params.url);
          const lines = transcriptItems.map((item: any) => item.text);
          return { content: [{ type: 'text', text: lines.join(' ') }], details: {} };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error fetching YouTube transcript: ${(error as Error).message}` }], details: {} };
        }
      }
    }
  ];
}

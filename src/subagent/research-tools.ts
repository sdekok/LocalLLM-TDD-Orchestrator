import { Type } from '@sinclair/typebox';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
// @ts-expect-error - Importing ESM dist directly for bundle compatibility
import * as yt from 'youtube-transcript/dist/youtube-transcript.esm.js';
const YoutubeTranscript = yt.YoutubeTranscript;
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

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

export function createResearchTools(): ToolDefinition[] {
  return [
    {
      name: 'fetch_and_convert_html',
      label: 'Fetch and Convert HTML to Markdown',
      description: 'Fetches a URL, extracts the main article content (stripping ads and navbars), and converts it into readable Markdown.',
      parameters: FetchAndConvertHtmlSchema,
      execute: async (toolCallId: string, params: FetchAndConvertHtmlArgs) => {
        try {
          const response = await fetch(params.url);
          if (!response.ok) {
            return { content: [{ type: 'text', text: `Failed to fetch URL: ${response.statusText}` }] , details: {} };
          }
          const html = await response.text();
          
          const dom = new JSDOM(html, { url: params.url });
          const reader = new Readability(dom.window.document);
          const article = reader.parse();
          
          if (!article || !article.content) {
            return { content: [{ type: 'text', text: 'Could not extract article content from the specified URL.' }] , details: {} };
          }
          
          const turndownService = new TurndownService({ headingStyle: 'atx' });
          const markdown = turndownService.turndown(article.content);
          
          return { content: [{ type: 'text', text: `# ${article.title}\n\n${markdown}` }] , details: {} };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error fetching or converting HTML: ${(error as Error).message}` }] , details: {} };
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
          return { content: [{ type: 'text', text: lines.join(' ') }] , details: {} };
        } catch (error) {
          return { content: [{ type: 'text', text: `Error fetching YouTube transcript: ${(error as Error).message}` }] , details: {} };
        }
      }
    }
  ];
}

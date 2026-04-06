import { getLogger } from '../utils/logger.js';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engine: string;
}

interface SearXNGResponse {
  results: SearchResult[];
  number_of_results: number;
  query: string;
}

export interface SearchOptions {
  categories?: string;
  engines?: string;
  maxResults?: number;
}

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

export class SearchClient {
  private baseURL: string;

  constructor(baseURL?: string) {
    this.baseURL = baseURL || SEARXNG_URL;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: options?.categories || 'it',
    });
    if (options?.engines) {
      params.set('engines', options.engines);
    }

    const response = await fetch(`${this.baseURL}/search?${params.toString()}`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`SearXNG search failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SearXNGResponse;
    const maxResults = options?.maxResults || 5;
    return data.results.slice(0, maxResults);
  }

  async searchAndSummarize(query: string, maxPages = 2): Promise<string> {
    const results = await this.search(query, { maxResults: maxPages });

    const pages: string[] = [];
    for (const result of results) {
      try {
        const response = await fetch(result.url, {
          signal: AbortSignal.timeout(8_000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TDDWorkflow/1.0)' },
        });
        const html = await response.text();
        const text = stripHTML(html).substring(0, 8_000);
        pages.push(`## ${result.title}\nSource: ${result.url}\n\n${text}`);
      } catch {
        pages.push(`## ${result.title}\nSource: ${result.url}\n\n${result.content}`);
      }
    }

    return pages.join('\n\n---\n\n');
  }
}

export function stripHTML(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Heuristic: should the orchestrator bother searching for this task?
 */
export function shouldSearch(taskDescription: string, attempt: number, lastFeedback?: string): boolean {
  if (attempt === 1 && hasExternalDependencies(taskDescription)) return true;
  if (attempt > 1 && lastFeedback?.match(/unknown|not found|deprecated|incorrect API/i)) return true;
  if (taskDescription.match(/refactor|rename|move|reorganize/i)) return false;
  return false;
}

export function hasExternalDependencies(text: string): boolean {
  const patterns = [
    /\b(express|fastify|next|react|vue|angular|nest)\b/i,
    /\b(jwt|oauth|graphql|grpc|websocket|redis|postgres|mongo|prisma)\b/i,
    /\b(aws|gcloud|azure|docker|kubernetes|terraform)\b/i,
    /\bAPI\b/,
  ];
  return patterns.some((p) => p.test(text));
}

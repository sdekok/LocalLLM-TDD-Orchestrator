import OpenAI from 'openai';
import JSON5 from 'json5';
import { ModelRouter, type TaskType, type ModelProfile } from './model-router.js';
import { getLogger } from '../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 180_000; // 3 minutes

export interface LLMClientConfig {
  timeoutMs: number;
  modelRouter: ModelRouter;
}

export class LLMClient {
  private clients = new Map<string, OpenAI>();  // Keyed by baseURL
  private timeoutMs: number;
  private router: ModelRouter;

  constructor(config?: Partial<LLMClientConfig>) {
    this.timeoutMs = config?.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.router = config?.modelRouter || new ModelRouter();
  }

  /**
   * Get or create an OpenAI client for a specific model profile.
   * Local models share one client; each cloud provider gets its own.
   */
  private getClient(profile: ModelProfile): OpenAI {
    const baseURL = this.router.getBaseURL(profile);
    const apiKey = this.router.getApiKey(profile) || 'sk-no-key-required';
    const cacheKey = `${baseURL}::${apiKey}`;

    if (!this.clients.has(cacheKey)) {
      this.clients.set(cacheKey, new OpenAI({ baseURL, apiKey }));
    }
    return this.clients.get(cacheKey)!;
  }

  /**
   * Estimate token count from text (~4 chars per token for English/code).
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate text to fit within a token budget, keeping head and tail.
   */
  truncateToTokenBudget(text: string, maxTokens: number): string {
    const estimated = this.estimateTokens(text);
    if (estimated <= maxTokens) return text;

    const charBudget = maxTokens * 4;
    const halfBudget = Math.floor(charBudget / 2);
    return (
      text.substring(0, halfBudget) +
      '\n\n... [TRUNCATED — content exceeded token budget] ...\n\n' +
      text.substring(text.length - halfBudget)
    );
  }

  async ask(
    systemPrompt: string,
    userPrompt: string,
    taskType: TaskType,
    temperature = 0.2
  ): Promise<string> {
    const logger = getLogger();
    const profile = this.router.selectModel(taskType);

    // Token budget enforcement
    const totalEstimate = this.estimateTokens(systemPrompt + userPrompt);
    const maxPrompt = profile.contextWindow - profile.maxOutputTokens - 1000; // safety margin
    if (totalEstimate > maxPrompt) {
      logger.warn(
        `Prompt ~${totalEstimate} tokens exceeds budget ~${maxPrompt}. Truncating user prompt.`
      );
      userPrompt = this.truncateToTokenBudget(
        userPrompt,
        maxPrompt - this.estimateTokens(systemPrompt)
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Merge sampling params: model config defaults + per-call override
      const sampling = profile.samplingParams || {};
      const effectiveTemp = temperature ?? sampling.temperature ?? 0.2;

      const modelIdentifier = this.router.getModelIdentifier(profile);
      logger.info(`LLM request: model=${modelIdentifier} provider=${profile.provider} task=${taskType} temp=${effectiveTemp}`);
      const client = this.getClient(profile);
      const response = await client.chat.completions.create(
        {
          model: modelIdentifier,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: effectiveTemp,
          max_tokens: profile.maxOutputTokens,
          top_p: sampling.top_p,
          frequency_penalty: sampling.frequency_penalty,
          presence_penalty: sampling.presence_penalty,
          // llama.cpp-specific params passed via extra_body
          ...(sampling.top_k || sampling.min_p || sampling.repeat_penalty
            ? {
                top_k: sampling.top_k,
                min_p: sampling.min_p,
                repeat_penalty: sampling.repeat_penalty,
              }
            : {}),
        },
        { signal: controller.signal }
      );

      const content = response.choices[0]?.message?.content || '';
      logger.info(`LLM response: ${content.length} chars`);
      return content;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`LLM request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  async askStructured<T>(
    systemPrompt: string,
    userPrompt: string,
    jsonSchema: Record<string, unknown>,
    taskType: TaskType,
    temperature = 0.1,
    maxRetries = 2
  ): Promise<T> {
    const logger = getLogger();
    let lastError: Error | null = null;
    let lastRaw = '';

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const prompt =
        attempt === 0
          ? `${systemPrompt}\n\nRespond ONLY with valid JSON matching this schema: ${JSON.stringify(jsonSchema)}. No markdown, no explanation.`
          : `${systemPrompt}\n\nYour previous response was not valid JSON. Error: ${lastError?.message}\n\nRespond with ONLY raw JSON. Schema: ${JSON.stringify(jsonSchema)}`;

      lastRaw = await this.ask(prompt, userPrompt, taskType, temperature);

      try {
        return extractJSON<T>(lastRaw);
      } catch (e: unknown) {
        lastError = e instanceof Error ? e : new Error(String(e));
        logger.warn(`JSON extraction attempt ${attempt + 1} failed: ${lastError.message}`);
      }
    }

    throw new Error(
      `Failed to get valid JSON after ${maxRetries} attempts. Last output:\n${lastRaw.substring(0, 500)}`
    );
  }
}

/**
 * Multi-strategy JSON extractor.
 * Handles: raw JSON, JSON in prose, markdown code blocks, trailing commas, comments, single quotes.
 */
export function extractJSON<T>(raw: string): T {
  // Strategy 1: Direct parse
  try {
    return JSON.parse(raw) as T;
  } catch { /* continue */ }

  // Strategy 2: Extract between first { and last }
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = raw.substring(firstBrace, lastBrace + 1);

    try {
      return JSON.parse(extracted) as T;
    } catch { /* continue */ }

    // JSON5 handles trailing commas, comments, single quotes
    try {
      return JSON5.parse(extracted) as T;
    } catch { /* continue */ }
  }

  // Strategy 3: Extract from markdown code blocks
  const codeBlockMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON5.parse(codeBlockMatch[1]) as T;
    } catch { /* continue */ }
  }

  throw new Error('Could not extract valid JSON from LLM response');
}

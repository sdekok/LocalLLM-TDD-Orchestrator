import OpenAI from 'openai';
import JSON5 from 'json5';
import { createHash } from 'crypto';
import type { ZodSchema } from 'zod';
import { ModelRouter, type TaskType, type ModelProfile } from './model-router.js';
import { getLogger } from '../utils/logger.js';

export class LLMClient {
  private clients = new Map<string, OpenAI>();
  public router: ModelRouter;

  constructor(modelRouter?: ModelRouter) {
    this.router = modelRouter || new ModelRouter();
  }

  getRoutingConfig(): ReturnType<ModelRouter['getConfig']>['routing'] {
    return this.router.getConfig().routing;
  }

  private getClient(profile: ModelProfile): OpenAI {
    const baseURL = this.router.getBaseURL(profile);
    const rawKey = this.router.getApiKey(profile);

    // Only use the placeholder for local providers — cloud providers must have
    // a real key or getApiKey() will have already thrown.
    const apiKey = rawKey ?? (profile.provider === 'local' ? 'sk-no-key-required' : undefined);
    if (!apiKey) {
      throw new Error(
        `No API key for "${profile.name}" (provider: ${profile.provider}). ` +
        `Set the ${profile.apiKeyEnvVar ?? `${profile.provider.toUpperCase()}_API_KEY`} environment variable.`
      );
    }

    // Hash the key so the raw secret never lives inside the Map key
    // (prevents accidental leakage if the Map is logged or inspected).
    const keyHash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    const cacheKey = `${baseURL}::${keyHash}`;

    if (!this.clients.has(cacheKey)) {
      this.clients.set(cacheKey, new OpenAI({ baseURL, apiKey }));
    }
    return this.clients.get(cacheKey)!;
  }

  async askStructured<T>(
    systemPrompt: string,
    userPrompt: string,
    jsonSchema: Record<string, unknown>,
    taskType: TaskType,
    temperature = 0.1,
    zodSchema?: ZodSchema<T>
  ): Promise<T> {
    const logger = getLogger();
    const profile = this.router.selectModel(taskType);
    const client = this.getClient(profile);
    const model = this.router.getModelIdentifier(profile);

    const finalPrompt = `${systemPrompt}\n\nRespond ONLY with valid JSON matching this schema: ${JSON.stringify(jsonSchema)}. No markdown, no explanation.`;

    logger.info(`LLM structured request: model=${model} task=${taskType}`);

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: finalPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...profile.samplingParams,
      temperature,
      max_tokens: profile.maxOutputTokens,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content || '';
    const parsed = extractJSON<T>(content);

    if (zodSchema) {
      const result = zodSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`LLM response failed validation: ${result.error.message}`);
      }
      return result.data;
    }

    return parsed;
  }
}

/** Build a Map cache key for an OpenAI client. Exported for unit testing. */
export function makeCacheKey(baseURL: string, apiKey: string): string {
  const keyHash = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return `${baseURL}::${keyHash}`;
}

export function extractJSON<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const extracted = raw.substring(firstBrace, lastBrace + 1);
      try {
        return JSON5.parse(extracted) as T;
      } catch { /* continue */ }
    }
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (codeBlockMatch?.[1]) {
      try {
        return JSON5.parse(codeBlockMatch[1]) as T;
      } catch { /* continue */ }
    }
    throw new Error('Could not extract valid JSON from LLM response');
  }
}

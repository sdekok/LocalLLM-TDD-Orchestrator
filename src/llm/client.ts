import OpenAI from 'openai';
import JSON5 from 'json5';
import { ModelRouter, type TaskType, type ModelProfile } from './model-router.js';
import { getLogger } from '../utils/logger.js';
import { getTuner } from './tuners/registry.js';

const DEFAULT_TIMEOUT_MS = 60_000; // 1 minute for planning

export class LLMClient {
  private clients = new Map<string, OpenAI>();
  public router: ModelRouter;

  constructor(modelRouter?: ModelRouter) {
    this.router = modelRouter || new ModelRouter();
  }

  private getClient(profile: ModelProfile): OpenAI {
    const baseURL = this.router.getBaseURL(profile);
    const apiKey = this.router.getApiKey(profile) || 'sk-no-key-required';
    const cacheKey = `${baseURL}::${apiKey}`;

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
    temperature = 0.1
  ): Promise<T> {
    const logger = getLogger();
    const profile = this.router.selectModel(taskType);
    const client = this.getClient(profile);
    const model = this.router.getModelIdentifier(profile);

    const tuner = getTuner(profile.modelFamily);
    const { systemPrompt: tunedPrompt, sampling } = tuner.applyTweaks(
      profile,
      systemPrompt,
      { temperature }
    );

    const finalPrompt = `${tunedPrompt}\n\nRespond ONLY with valid JSON matching this schema: ${JSON.stringify(jsonSchema)}. No markdown, no explanation.`;

    logger.info(`LLM structured request: model=${model} task=${taskType}`);

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: finalPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...sampling,
      max_tokens: profile.maxOutputTokens,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content || '';
    return extractJSON<T>(content);
  }
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

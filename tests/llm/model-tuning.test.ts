import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter, type ModelRouterConfig } from '../../src/llm/model-router.js';
import { LLMClient } from '../../src/llm/client.js';

function makeTestConfig(): ModelRouterConfig {
  return {
    models: {
      'thinking-model': {
        name: 'Thinking Model',
        ggufFilename: 'thinking-27b.gguf',
        provider: 'local',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        architecture: 'dense',
        speed: 'slow',
        enableThinking: true,
      },
      'fast-model': {
        name: 'Fast Model',
        ggufFilename: 'fast-30b-a3b.gguf',
        provider: 'local',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        architecture: 'moe',
        speed: 'fast',
        enableThinking: false,
        samplingParams: { temperature: 0.3, top_k: 20 },
      },
    },
    routing: {
      plan: 'thinking-model',
      implement: 'fast-model',
    },
  };
}

describe('ModelRouter sampling', () => {
  it('returns empty object when samplingParams is omitted from profile', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('plan'); // thinking-model has no samplingParams
    expect(params.temperature).toBeUndefined();
    expect(params.top_k).toBeUndefined();
  });

  it('returns configured samplingParams when present', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('implement'); // fast-model has samplingParams
    expect(params.temperature).toBe(0.3);
    expect(params.top_k).toBe(20);
  });
});

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({
    choices: [{ message: { content: '{"status": "ok"}' } }]
  })
}));

vi.mock('openai', () => {
  class MockOpenAI {
    chat = { completions: { create: mockCreate } }
  }
  return { default: MockOpenAI, OpenAI: MockOpenAI };
});

describe('LLMClient.askStructured', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"status": "ok"}' } }]
    });
  });

  it('passes the system prompt through without modification', async () => {
    const client = new LLMClient(new ModelRouter(makeTestConfig()));
    await client.askStructured('You are a helpful assistant.', 'Help me', { type: 'object' }, 'plan');

    const args = mockCreate.mock.calls[0][0];
    expect(args.messages[0].content).toContain('You are a helpful assistant.');
    expect(args.messages[0].content).not.toContain('<|think|>');
  });

  it('merges profile samplingParams with the caller-supplied temperature', async () => {
    const client = new LLMClient(new ModelRouter(makeTestConfig()));
    await client.askStructured('System', 'User', { type: 'object' }, 'implement', 0.1);

    const args = mockCreate.mock.calls[0][0];
    expect(args.temperature).toBe(0.1);   // caller wins
    expect(args.top_k).toBe(20);           // from profile.samplingParams
  });

  it('uses only the caller temperature when profile has no samplingParams', async () => {
    const client = new LLMClient(new ModelRouter(makeTestConfig()));
    await client.askStructured('System', 'User', { type: 'object' }, 'plan', 0.2);

    const args = mockCreate.mock.calls[0][0];
    expect(args.temperature).toBe(0.2);
    expect(args.top_k).toBeUndefined();
  });
});

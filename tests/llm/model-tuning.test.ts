import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelRouter, type ModelRouterConfig } from '../../src/llm/model-router.js';
import { LLMClient } from '../../src/llm/client.js';

function makeTestConfig(): ModelRouterConfig {
  return {
    models: {
      'gemma-test': {
        name: 'Gemma 4',
        ggufFilename: 'gemma-4.gguf',
        provider: 'local',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        architecture: 'dense',
        speed: 'fast',
        modelFamily: 'gemma4',
        enableThinking: true,
      },
      'qwen-think-test': {
        name: 'Qwen 3',
        ggufFilename: 'qwen-3.gguf',
        provider: 'local',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        architecture: 'moe',
        speed: 'medium',
        modelFamily: 'qwen35',
        enableThinking: true,
      },
      'qwen-instruct': {
        name: 'Qwen 3 Instruct',
        ggufFilename: 'qwen-3-ins.gguf',
        provider: 'local',
        contextWindow: 128000,
        maxOutputTokens: 8192,
        architecture: 'moe',
        speed: 'fast',
        modelFamily: 'qwen35',
        enableThinking: false,
      },
    },
    routing: {
      plan: 'gemma-test',
      implement: 'qwen-think-test',
      review: 'qwen-instruct',
    },
  };
}

describe('Model Tuning and Family Defaults', () => {
  it('returns empty when samplingParams is omitted', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('plan');
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.top_k).toBeUndefined();
  });

  it('preserves empty sampling across families', () => {
    const router = new ModelRouter(makeTestConfig());
    const thinkParams = router.getSamplingParams('implement');
    const instructParams = router.getSamplingParams('review');
    expect(thinkParams.temperature).toBeUndefined();
    expect(instructParams.temperature).toBeUndefined();
  });
});

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn().mockResolvedValue({
    choices: [{ message: { content: '{"status": "ok"}' } }]
  })
}));

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate
      }
    }
  }
  return {
    default: MockOpenAI,
    OpenAI: MockOpenAI
  };
});

describe('Model Tuning and Family Defaults', () => {
  it('returns empty when samplingParams is omitted', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('plan');
    expect(params.temperature).toBeUndefined();
  });
});

describe('LLMClient Prompt Mutations', () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"status": "ok"}' } }]
    });
  });

  it('injects <|think|> into system prompt for gemma4 with thinking enabled', async () => {
    const router = new ModelRouter(makeTestConfig());
    const client = new LLMClient(router);
    
    await client.askStructured('You are a helpful assistant.', 'Help me', { type: 'object' }, 'plan');
    
    expect(mockCreate).toHaveBeenCalled();
    const args = mockCreate.mock.calls[0][0];
    
    expect(args.messages[0].role).toBe('system');
    expect(args.messages[0].content).toContain('<|think|>\nYou are a helpful assistant.');
  });

  it('does NOT floor temperature for qwen thinking models (trusting server)', async () => {
    const router = new ModelRouter(makeTestConfig());
    const client = new LLMClient(router);
    
    await client.askStructured('System', 'User', { type: 'object' }, 'implement', 0.1);
    
    const args = mockCreate.mock.calls[0][0];
    expect(args.temperature).toBe(0.1); 
  });

  it('allows temperature lower than 0.6 for qwen instruct models', async () => {
    const router = new ModelRouter(makeTestConfig());
    const client = new LLMClient(router);
    
    await client.askStructured('System', 'User', { type: 'object' }, 'review', 0.1);
    
    const args = mockCreate.mock.calls[0][0];
    expect(args.temperature).toBe(0.1); // Should remain 0.1 since not thinking
  });
});

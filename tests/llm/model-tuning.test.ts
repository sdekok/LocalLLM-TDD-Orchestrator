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
  it('supplies gemma4 defaults when samplingParams is omitted', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('plan');
    expect(params.temperature).toBe(1.0);
    expect(params.top_p).toBe(0.95);
    expect(params.top_k).toBe(64);
  });

  it('supplies qwen thinking defaults', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('implement');
    expect(params.temperature).toBe(0.6);
    expect(params.top_p).toBe(0.95);
    expect(params.top_k).toBe(20);
  });

  it('supplies qwen instruct defaults', () => {
    const router = new ModelRouter(makeTestConfig());
    const params = router.getSamplingParams('review');
    expect(params.temperature).toBe(0.7);
    expect(params.top_p).toBe(0.8);
  });
});

describe('LLMClient Prompt Mutations', () => {
  let mockCreate: any;

  beforeEach(() => {
    mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'mock test' } }]
    });

    vi.mock('openai', () => {
      return {
        default: vi.fn().mockImplementation(() => {
          return {
            chat: {
              completions: {
                create: mockCreate
              }
            }
          };
        })
      };
    });
  });

  it('injects <|think|> into system prompt for gemma4 with thinking enabled', async () => {
    const router = new ModelRouter(makeTestConfig());
    const client = new LLMClient({ modelRouter: router });
    
    // Using simple mock to just check arguments passed to OpenAI
    // We already mocked OpenAI natively above, but LLMClient uses its own client cache instance
    // Let's just bypass the actual network call somehow. Actually our vi.mock('openai') takes care of it.
    await client.ask('You are a helpful assistant.', 'Help me', 'plan');
    
    expect(mockCreate).toHaveBeenCalled();
    const args = mockCreate.mock.calls[0][0];
    
    expect(args.messages[0].role).toBe('system');
    expect(args.messages[0].content).toBe('<|think|>\nYou are a helpful assistant.');
  });

  it('floors temperature to 0.6 for qwen thinking models', async () => {
    const router = new ModelRouter(makeTestConfig());
    const client = new LLMClient({ modelRouter: router });
    
    await client.ask('System', 'User', 'implement', 0.1); // Ask explicitly passes 0.1
    
    const args = mockCreate.mock.calls[0][0];
    expect(args.temperature).toBe(0.6); // Should be floored!
  });

  it('allows temperature lower than 0.6 for qwen instruct models', async () => {
    const router = new ModelRouter(makeTestConfig());
    const client = new LLMClient({ modelRouter: router });
    
    await client.ask('System', 'User', 'review', 0.1); // Ask explicitly passes 0.1
    
    const args = mockCreate.mock.calls[0][0];
    expect(args.temperature).toBe(0.1); // Should remain 0.1 since not thinking
  });
});

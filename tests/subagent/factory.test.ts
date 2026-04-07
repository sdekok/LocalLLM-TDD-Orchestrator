import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubAgentSession } from '../../src/subagent/factory.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import { IMPLEMENTER_PROMPT } from '../../src/subagent/prompts.js';

// Mock Pi SDK
vi.mock('@mariozechner/pi-coding-agent', () => {
  const DefaultResourceLoader = vi.fn().mockImplementation(function(this: any, config) {
    this.systemPromptOverride = config.systemPromptOverride;
    this.reload = vi.fn().mockResolvedValue(undefined);
  });

  const createAgentSession = vi.fn().mockImplementation(async (options) => {
    const systemPrompt = options.resourceLoader?.systemPromptOverride?.() || '';
    return {
      session: {
        agent: { state: { systemPrompt } },
        setThinkingLevel: vi.fn(),
        dispose: vi.fn(),
      }
    };
  });

  return {
    createAgentSession,
    SessionManager: {
      inMemory: vi.fn().mockReturnValue({}),
    },
    DefaultResourceLoader,
    createCodingTools: vi.fn().mockReturnValue([]),
    createReadOnlyTools: vi.fn().mockReturnValue([]),
  };
});

describe('SubAgent Factory', () => {
  const modelRouter = new ModelRouter({
    models: {
      'test-model': {
        name: 'Test Model',
        ggufFilename: 'test.gguf',
        provider: 'local',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        architecture: 'dense',
        speed: 'fast',
        modelFamily: 'generic',
        enableThinking: false,
      }
    },
    routing: { implement: 'test-model' }
  });

  it('spawns a session with the correct system prompt', async () => {
    const session = await createSubAgentSession({
      taskType: 'implement',
      systemPrompt: 'BASE PROMPT {feedbackContext}',
      cwd: '/tmp',
      modelRouter,
      feedback: 'FIX THIS'
    });

    expect(session.agent.state.systemPrompt).toContain('BASE PROMPT');
    expect(session.agent.state.systemPrompt).toContain('FIX THIS');
  });

  it('sets thinking level based on model profile', async () => {
    // Test with thinking enabled
    const thinkingRouter = new ModelRouter({
      models: {
        'think-model': {
          ...modelRouter.getConfig().models['test-model']!,
          enableThinking: true
        }
      },
      routing: { implement: 'think-model' }
    });

    const session = await createSubAgentSession({
      taskType: 'implement',
      systemPrompt: 'PROMPT',
      cwd: '/tmp',
      modelRouter: thinkingRouter,
    });

    expect(session.setThinkingLevel).toHaveBeenCalledWith('medium');
  });
});

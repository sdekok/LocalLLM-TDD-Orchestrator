import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubAgentSession, _activeSessionCount } from '../../src/subagent/factory.js';
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
        getAllTools: vi.fn().mockReturnValue([]),
        modelRegistry: {
          getAll: vi.fn().mockReturnValue([]),
        },
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
    createBashTool: vi.fn().mockReturnValue({}),
    createGrepTool: vi.fn().mockReturnValue({}),
    createFindTool: vi.fn().mockReturnValue({}),
    createLsTool: vi.fn().mockReturnValue({}),
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

  // ─── session registry / shutdown-handler integration ─────────────────────

  describe('session registry', () => {
    it('registers created sessions so they can be cleaned up on shutdown', async () => {
      const before = _activeSessionCount();
      const session = await createSubAgentSession({
        taskType: 'implement',
        systemPrompt: 'PROMPT',
        cwd: '/tmp',
        modelRouter,
      });

      expect(_activeSessionCount()).toBe(before + 1);

      // Calling dispose removes the session from the registry
      session.dispose();
      expect(_activeSessionCount()).toBe(before);
    });

    it('unregisters a session exactly once even if dispose is called twice', async () => {
      const before = _activeSessionCount();
      const session = await createSubAgentSession({
        taskType: 'implement',
        systemPrompt: 'PROMPT',
        cwd: '/tmp',
        modelRouter,
      });
      expect(_activeSessionCount()).toBe(before + 1);

      session.dispose();
      session.dispose();
      expect(_activeSessionCount()).toBe(before);
    });

    it('tracks multiple concurrent sessions', async () => {
      const before = _activeSessionCount();
      const s1 = await createSubAgentSession({ taskType: 'implement', systemPrompt: 'P', cwd: '/tmp', modelRouter });
      const s2 = await createSubAgentSession({ taskType: 'implement', systemPrompt: 'P', cwd: '/tmp', modelRouter });
      const s3 = await createSubAgentSession({ taskType: 'implement', systemPrompt: 'P', cwd: '/tmp', modelRouter });

      expect(_activeSessionCount()).toBe(before + 3);

      s1.dispose();
      expect(_activeSessionCount()).toBe(before + 2);
      s2.dispose();
      s3.dispose();
      expect(_activeSessionCount()).toBe(before);
    });
  });
});

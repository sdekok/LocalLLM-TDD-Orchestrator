import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubAgentSession, _activeSessionCount } from '../../src/subagent/factory.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import { IMPLEMENTER_PROMPT } from '../../src/subagent/prompts.js';

// Capture the most recent createAgentSession() call so individual tests can
// inspect the tool allowlist that was passed in. Reset in beforeEach.
const capturedCalls: { tools?: string[] }[] = [];

// Mock Pi SDK
vi.mock('@earendil-works/pi-coding-agent', () => {
  const DefaultResourceLoader = vi.fn().mockImplementation(function(this: any, config) {
    this.systemPrompt = config.systemPrompt;
    this.reload = vi.fn().mockResolvedValue(undefined);
  });

  const createAgentSession = vi.fn().mockImplementation(async (options) => {
    capturedCalls.push({ tools: options.tools });
    const systemPrompt = options.resourceLoader?.systemPrompt ?? '';
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
      create: vi.fn().mockReturnValue({ getSessionFile: () => '/tmp/.tdd-workflow/sessions/test.jsonl' }),
    },
    DefaultResourceLoader,
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

  it('passes a non-empty tool allowlist for coding tasks', async () => {
    capturedCalls.length = 0;
    await createSubAgentSession({
      taskType: 'implement',
      systemPrompt: 'PROMPT',
      cwd: '/tmp',
      modelRouter,
    });
    const call = capturedCalls.at(-1);
    expect(call?.tools).toBeDefined();
    // Base tools always included
    expect(call!.tools).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']));
  });

  it('includes ctx_* tools in the allowlist when context-mode is detected', async () => {
    // This test only meaningfully runs on machines where ~/.pi/agent/settings.json
    // lists context-mode (the bug we're guarding against was that ctx_execute
    // was silently filtered out of the session). On CI or fresh installs where
    // context-mode is absent, the test is a no-op assertion.
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
    let hasContextMode = false;
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { packages?: string[] };
      hasContextMode = (settings.packages ?? []).some(p =>
        p.toLowerCase().includes('context-mode') || p.toLowerCase().includes('pi-mcp-adapter'),
      );
    } catch { /* settings.json absent — test is skipped */ }

    if (!hasContextMode) return;

    capturedCalls.length = 0;
    await createSubAgentSession({
      taskType: 'implement',
      systemPrompt: 'PROMPT',
      cwd: '/tmp',
      modelRouter,
    });
    const call = capturedCalls.at(-1);
    expect(call?.tools).toEqual(expect.arrayContaining(['ctx_execute', 'ctx_execute_file']));
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

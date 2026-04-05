import { describe, it, expect, vi, beforeEach } from 'vitest';
import { planProject } from '../../src/agents/project-planner.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import { createSubAgentSession } from '../../src/subagent/factory.js';

// Mock the subagent factory
vi.mock('../../src/subagent/factory.js', () => ({
  createSubAgentSession: vi.fn(),
}));

describe('ProjectPlanner', () => {
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
    routing: { 'project-plan': 'test-model' }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns a project planning session and prompts it', async () => {
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      agent: { state: { systemPrompt: 'Test Prompt' } },
    };
    (createSubAgentSession as any).mockResolvedValue(mockSession);

    const result = await planProject('Test request', modelRouter, '/tmp');

    expect(createSubAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      taskType: 'project-plan',
      cwd: '/tmp',
    }));
    expect(mockSession.prompt).toHaveBeenCalledWith('Test request');
    expect(mockSession.dispose).toHaveBeenCalled();
    expect(result.summary).toContain('Project planning complete');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { performDeepResearch } from '../../src/agents/researcher.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import * as fs from 'fs';

// Mock subagent framework
let mockPrompt = vi.fn();
let mockDispose = vi.fn();
let mockSubscribe = vi.fn();

vi.mock('../../src/subagent/factory.js', () => ({
  createSubAgentSession: vi.fn().mockImplementation(async () => ({
    prompt: mockPrompt,
    dispose: mockDispose,
    subscribe: mockSubscribe,
  }))
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('Mock Content'),
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    }),
  };
});

vi.mock('youtube-transcript/dist/youtube-transcript.esm.js', () => ({
  YoutubeTranscript: {
    fetchTranscript: vi.fn().mockResolvedValue([{ text: 'mock' }])
  }
}));

describe('Researcher Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  const uiContext = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    editor: vi.fn().mockResolvedValue(null)
  };

  it('runs foreground research correctly', async () => {
    await performDeepResearch('React State 2026', '/tmp', modelRouter, null, {
      background: false,
      uiContext
    });

    expect(uiContext.setStatus).toHaveBeenCalledWith('research', '🔍 Launching Researcher Agent...');
    expect(mockPrompt).toHaveBeenCalledWith(expect.stringContaining('React State 2026'));
    expect(uiContext.notify).toHaveBeenCalledWith(expect.stringContaining('Deep Research completed'), 'info');
    expect(uiContext.editor).toHaveBeenCalledWith('Research/react_state_2026.md', 'Mock Content');
    expect(mockDispose).toHaveBeenCalled();
  });

  it('runs background research correctly', async () => {
    await performDeepResearch('Test Topic', '/tmp', modelRouter, null, {
      background: true,
      uiContext
    });

    expect(uiContext.notify).toHaveBeenCalledWith(expect.stringContaining('started in the background'), 'info');
    
    // allow next tick for promises
    await new Promise(r => setImmediate(r));
    
    expect(mockPrompt).toHaveBeenCalledWith(expect.stringContaining('Test Topic'));
    expect(uiContext.notify).toHaveBeenCalledWith(expect.stringContaining('Saved to'), 'info');
    expect(mockDispose).toHaveBeenCalled();
  });
});

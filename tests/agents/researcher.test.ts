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

  it('adds searxng_search tool if searchClient is provided', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const mockSearchClient = { search: vi.fn() };
    
    await performDeepResearch('Test', '/tmp', modelRouter, mockSearchClient as any, {
      background: false,
      uiContext
    });

    const callArgs = (createSubAgentSession as any).mock.calls[0][0];
    const searchTool = callArgs.customTools.find((t: any) => t.name === 'searxng_search');
    expect(searchTool).toBeDefined();
    
    // Test the tool execution
    mockSearchClient.search.mockResolvedValue([{ title: 'Result' }]);
    const toolResult = await searchTool.execute('id', { query: 'query' });
    expect(toolResult.content[0].text).toContain('Result');
  });

  it('handles foreground errors', async () => {
    mockPrompt.mockRejectedValue(new Error('Prompt failed'));
    
    await performDeepResearch('Test', '/tmp', modelRouter, null, {
      background: false,
      uiContext
    });

    expect(uiContext.notify).toHaveBeenCalledWith(expect.stringContaining('Research failed'), 'error');
  });

  it('triggers setStatus on tool execution events', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    let capturedCallback: any;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => ({
      prompt: vi.fn(),
      dispose: vi.fn(),
      subscribe: (cb: any) => { capturedCallback = cb; }
    }));

    await performDeepResearch('Test', '/tmp', modelRouter, null, {
      background: false,
      uiContext
    });

    capturedCallback({ type: 'tool_execution_start', toolName: 'test-tool' });
    expect(uiContext.setStatus).toHaveBeenCalledWith('research', expect.stringContaining('test-tool'));
  });

  it('creates Research directory if it does not exist', async () => {
    const mockFs = fs as any;
    mockFs.existsSync.mockReturnValueOnce(false); // first call for researchDir

    await performDeepResearch('Test', '/tmp', modelRouter, null, {
      background: false,
      uiContext
    });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('Research'), expect.any(Object));
  });
});

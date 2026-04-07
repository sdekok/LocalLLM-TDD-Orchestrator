import { describe, it, expect, vi, beforeEach } from 'vitest';
import { planAndBreakdown } from '../../src/agents/planner.js';
import { ModelRouter } from '../../src/llm/model-router.js';

// Mock dependencies
const mockAskStructured = vi.fn();
vi.mock('../../src/llm/client.js', () => ({
  LLMClient: vi.fn().mockImplementation(function() {
    return { askStructured: mockAskStructured };
  }),
}));

const mockSearchAndSummarize = vi.fn();
vi.mock('../../src/search/searxng.js', () => ({
  shouldSearch: vi.fn().mockReturnValue(true),
  SearchClient: vi.fn().mockImplementation(function() {
    return { searchAndSummarize: mockSearchAndSummarize };
  }),
}));

vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('mock-uuid'),
}));

describe('Planner Agent', () => {
  const mockModelRouter = new ModelRouter({
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

  it('plans and breaks down a request without search', async () => {
    mockAskStructured.mockResolvedValue({
      reasoning: 'Detailed reasoning',
      refinedRequest: 'Refined Request',
      subtasks: [{ description: 'Task 1', affectedFiles: ['file.ts'] }],
    });

    const result = await planAndBreakdown('Original Request', mockModelRouter);

    expect(result.refinedRequest).toBe('Refined Request');
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]?.id).toBe('mock-uuid');
    expect(result.subtasks[0]?.description).toBe('Task 1');
    expect(mockAskStructured).toHaveBeenCalled();
  });

  it('performs research when searchClient is provided and shouldSearch is true', async () => {
    const { shouldSearch } = await import('../../src/search/searxng.js');
    (shouldSearch as any).mockReturnValue(true);
    mockSearchAndSummarize.mockResolvedValue('Research Summary');
    mockAskStructured.mockResolvedValue({
      reasoning: 'Test reasoning',
      refinedRequest: 'Refined',
      subtasks: [],
    });

    const { SearchClient } = await import('../../src/search/searxng.js');
    const searchClient = new SearchClient('http://test');

    await planAndBreakdown('Original Request', mockModelRouter, searchClient);

    expect(mockSearchAndSummarize).toHaveBeenCalledWith(
      expect.stringContaining('Original Request'),
      2
    );
    expect(mockAskStructured).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Research Summary'),
      expect.any(Object),
      'plan',
      0.3
    );
  });

  it('handles search failure gracefully', async () => {
    const { shouldSearch } = await import('../../src/search/searxng.js');
    (shouldSearch as any).mockReturnValue(true);
    mockSearchAndSummarize.mockRejectedValue(new Error('Search failed'));
    mockAskStructured.mockResolvedValue({
      reasoning: 'Test reasoning',
      refinedRequest: 'Refined',
      subtasks: [],
    });

    const { SearchClient } = await import('../../src/search/searxng.js');
    const searchClient = new SearchClient('http://test');

    await expect(planAndBreakdown('Original Request', mockModelRouter, searchClient)).resolves.not.toThrow();
    expect(mockAskStructured).toHaveBeenCalled();
  });
});

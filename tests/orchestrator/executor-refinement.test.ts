import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { WorkflowExecutor } from '../../src/orchestrator/executor.js';
import { StateManager } from '../../src/orchestrator/state.js';
import { ModelRouter } from '../../src/llm/model-router.js';
import { planAndBreakdown } from '../../src/agents/planner.js';
import { EpicLoader } from '../../src/orchestrator/epic-loader.js';

// Mock dependencies
vi.mock('../../src/agents/planner.js', () => ({
  planAndBreakdown: vi.fn(),
}));

vi.mock('../../src/orchestrator/quality-gates.js', () => ({
  runQualityGates: vi.fn(),
  detectTestCommand: vi.fn(),
  formatGateFailures: vi.fn(),
}));

vi.mock('../../src/orchestrator/epic-loader.js', () => {
  return {
    EpicLoader: vi.fn().mockImplementation(() => {
      return {
        findEpic: vi.fn(),
        parseEpic: vi.fn(),
      };
    }),
  };
});

describe('WorkflowExecutor - Refinement and Epic Loading', () => {
  let projectDir: string;
  let state: StateManager;
  let modelRouter: ModelRouter;
  let executor: WorkflowExecutor;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-refinement-test-'));
    state = new StateManager(projectDir);
    modelRouter = new ModelRouter({
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
      routing: { plan: 'test-model', implement: 'test-model', review: 'test-model' }
    });
    executor = new WorkflowExecutor(state, modelRouter);
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it('refines a vague task into technical subtasks without modifying state directly', async () => {
    state.initWorkflow('Test workflow');
    state.setSubtasks([{ id: 'task-1', description: 'Add math' }]);

    (planAndBreakdown as any).mockResolvedValue({
      refinedRequest: 'Technical Math Plan',
      subtasks: [
        { id: 'sub-1', description: 'Implement add()' },
        { id: 'sub-2', description: 'Implement subtract()' },
      ]
    });

    const technicalPlan = await executor.refineTaskIntoSubtasks('task-1', 1);

    expect(planAndBreakdown).toHaveBeenCalled();
    expect(technicalPlan).toContain('Implement add()');
    expect(technicalPlan).toContain('Implement subtract()');
    
    // Original task remains in state
    expect(state.getSubtask('task-1')?.description).toBe('Add math');
  });

  it('loads work items from a pre-planned epic if a match is found', async () => {
    // We need to capture the instance created inside startNew
    const mockFindEpic = vi.fn().mockReturnValue('/mock/path/epic-01.md');
    const mockParseEpic = vi.fn().mockReturnValue({
      title: 'Database Migration',
      summary: 'Add DB layer',
      dependencies: [],
      architecturalDecisions: [],
      workItems: [
        { id: 'WI-1', title: 'Setup DB', description: 'Acceptance: working DB' },
        { id: 'WI-2', title: 'Add Tables', description: 'Acceptance: users table exists' },
      ]
    });

    (EpicLoader as any).mockImplementation(function() {
      return {
        findEpic: mockFindEpic,
        parseEpic: mockParseEpic,
      };
    });

    // Need a new executor instance because the previous one might have cached the mock or we want a fresh start
    const newExecutor = new WorkflowExecutor(state, modelRouter);
    
    // We need to mock processQueue to avoid actual execution which requires more mocks
    (newExecutor as any).processQueue = vi.fn().mockResolvedValue(undefined);

    await newExecutor.startNew('Implement Database Migration');

    expect(mockFindEpic).toHaveBeenCalledWith('Implement Database Migration');
    expect(mockParseEpic).toHaveBeenCalledWith('/mock/path/epic-01.md');

    const subtasks = state.getState().subtasks;
    expect(subtasks).toHaveLength(2);
    expect(subtasks[0]?.description).toBe('Acceptance: working DB');
    expect(subtasks[1]?.description).toBe('Acceptance: users table exists');
  });
});

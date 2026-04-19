/**
 * Tests for WorkflowExecutor.subscribeToSession and related chatMessage wiring.
 *
 * subscribeToSession is private but is the only code path that translates Pi SDK
 * session events into chatMessage calls. We access it via (executor as any) to
 * keep the tests focused on the observable output rather than internal structure.
 */
// Eliminate the 5-second slot recovery delay so processQueue tests finish quickly
process.env['TDD_SLOT_RECOVERY_MS'] = '0';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { WorkflowExecutor } from '../../src/orchestrator/executor.js';
import { StateManager } from '../../src/orchestrator/state.js';
import { ModelRouter } from '../../src/llm/model-router.js';

// ---------- module mocks ----------

vi.mock('../../src/agents/planner.js', () => ({
  planAndBreakdown: vi.fn(),
}));

vi.mock('../../src/utils/exec.js', () => ({
  execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  DEFAULT_MAX_BUFFER: 10 * 1024 * 1024,
}));

vi.mock('../../src/orchestrator/quality-gates.js', () => ({
  runQualityGates: vi.fn(),
  detectTestCommand: vi.fn(),
  formatGateFailures: vi.fn(),
}));

vi.mock('../../src/orchestrator/epic-loader.js', () => ({
  EpicLoader: vi.fn().mockImplementation(function () {
    return {
      findEpic: vi.fn().mockReturnValue(null),
      parseEpic: vi.fn(),
    };
  }),
}));

vi.mock('../../src/subagent/factory.js', () => ({
  createSubAgentSession: vi.fn(),
}));

vi.mock('../../src/orchestrator/sandbox.js', () => {
  const sandboxInstance = {
    createBranch: vi.fn(async () => undefined),
    getCurrentBranch: vi.fn(async () => 'main'),
    rollback: vi.fn(async () => undefined),
    mergeAndCleanup: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
  };
  // Use a plain constructor function so `new Sandbox()` works inside Vitest's mock hoisting
  function MockSandbox() { return sandboxInstance; }
  return { Sandbox: MockSandbox };
});

// ---------- helpers ----------

function makeModelRouter() {
  return new ModelRouter({
    models: {
      'test-model': {
        name: 'Test',
        ggufFilename: 'test.gguf',
        provider: 'local',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        architecture: 'dense',
        speed: 'fast',
        enableThinking: false,
      },
    },
    routing: { plan: 'test-model', implement: 'test-model', review: 'test-model' },
  });
}

/**
 * Creates a minimal mock session with a controllable subscribe listener.
 * Returns the session mock and a helper to fire session events.
 */
function makeMockSession() {
  let listener: ((event: any) => void) | null = null;
  const session = {
    subscribe: vi.fn((fn: (event: any) => void) => {
      listener = fn;
      return () => { listener = null; };
    }),
    prompt: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    messages: [],
  };
  const fire = (event: any) => {
    if (listener) listener(event);
  };
  return { session, fire };
}

function makeMessageUpdateEvent(ae: Record<string, unknown>) {
  return { type: 'message_update', assistantMessageEvent: ae };
}

// ---------- tests ----------

describe('subscribeToSession — event → chatMessage mapping', () => {
  let projectDir: string;
  let state: StateManager;
  let chatMessage: ReturnType<typeof vi.fn>;
  let executor: WorkflowExecutor;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-stream-test-'));
    state = new StateManager(projectDir);
    chatMessage = vi.fn();
    executor = new WorkflowExecutor(state, makeModelRouter(), { chatMessage });
    vi.clearAllMocks();
    chatMessage = vi.fn();
    // Re-assign chatMessage on the fresh executor after clearAllMocks
    (executor as any).chatMessage = chatMessage;
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // ── no-op when chatMessage is absent ──────────────────────────────────────

  it('does nothing when chatMessage is null', () => {
    const { session, fire } = makeMockSession();
    (executor as any).chatMessage = null;
    (executor as any).subscribeToSession(session, 'Label');

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    expect(session.subscribe).not.toHaveBeenCalled();
    expect(chatMessage).not.toHaveBeenCalled();
  });

  // ── thinking_start ────────────────────────────────────────────────────────

  it('posts Thinking… immediately on thinking_start', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Impl WI-1');

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));

    expect(chatMessage).toHaveBeenCalledOnce();
    expect(chatMessage.mock.calls[0][0]).toContain('Thinking…');
    expect(chatMessage.mock.calls[0][0]).toContain('[Impl WI-1]');
  });

  // ── thinking_delta — buffering ────────────────────────────────────────────

  it('buffers thinking_delta content and does not post until chunk threshold', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    chatMessage.mockClear(); // ignore the Thinking… notification

    // Send something shorter than the 800-char chunk size
    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'x'.repeat(400) }));

    // Should NOT have posted a chunk yet
    expect(chatMessage).not.toHaveBeenCalled();
  });

  it('posts a chunk when accumulated thinking_delta exceeds 800 chars', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    chatMessage.mockClear();

    // Two deltas that together exceed 800 chars
    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'a'.repeat(500) }));
    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'b'.repeat(400) }));

    // Should have posted exactly one chunk
    expect(chatMessage).toHaveBeenCalledOnce();
    const posted = chatMessage.mock.calls[0][0] as string;
    expect(posted).toContain('💭');
    expect(posted.length).toBeLessThanOrEqual(
      '**[Label]** 💭 '.length + 800 + 10 // some slack for prefix
    );
  });

  it('posts multiple chunks for very long thinking content', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    chatMessage.mockClear();

    // 2500 chars → should produce at least 3 chunks (800, 800, 900)
    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'z'.repeat(2500) }));

    expect(chatMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // ── thinking_end — flush remainder ───────────────────────────────────────

  it('flushes remaining buffered thinking content on thinking_end', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    chatMessage.mockClear();

    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'partial content' }));
    expect(chatMessage).not.toHaveBeenCalled(); // still buffered

    fire(makeMessageUpdateEvent({ type: 'thinking_end', content: 'partial content' }));

    expect(chatMessage).toHaveBeenCalledOnce();
    expect(chatMessage.mock.calls[0][0]).toContain('partial content');
  });

  it('does not post on thinking_end when buffer is empty (chunk already flushed)', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    chatMessage.mockClear();

    // Exactly 800 chars → flushes in the delta handler, buffer becomes empty
    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'x'.repeat(800) }));
    expect(chatMessage).toHaveBeenCalledOnce(); // chunk posted
    chatMessage.mockClear();

    fire(makeMessageUpdateEvent({ type: 'thinking_end', content: 'x'.repeat(800) }));

    // Buffer was empty — thinking_end should post nothing
    expect(chatMessage).not.toHaveBeenCalled();
  });

  it('resets the buffer on the next thinking_start so blocks do not bleed into each other', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    // Block 1: start, partial delta
    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'block-one' }));
    fire(makeMessageUpdateEvent({ type: 'thinking_end', content: 'block-one' }));
    chatMessage.mockClear();

    // Block 2
    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    fire(makeMessageUpdateEvent({ type: 'thinking_delta', delta: 'block-two' }));
    fire(makeMessageUpdateEvent({ type: 'thinking_end', content: 'block-two' }));

    // Only block-two content should appear in the second round
    const allCalls = chatMessage.mock.calls.map(c => c[0] as string);
    const flushCall = allCalls.find(s => s.includes('block-two'));
    expect(flushCall).toBeDefined();
    const blockOneInSecondRound = allCalls.some(s => s.includes('block-one') && s.includes('block-two'));
    expect(blockOneInSecondRound).toBe(false);
  });

  // ── text_end ──────────────────────────────────────────────────────────────

  it('posts text_end content with label prefix', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Reviewer WI-2');

    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'APPROVED: true\nFEEDBACK: Looks great' }));

    expect(chatMessage).toHaveBeenCalledOnce();
    const posted = chatMessage.mock.calls[0][0] as string;
    expect(posted).toContain('[Reviewer WI-2]');
    expect(posted).toContain('APPROVED: true');
  });

  it('skips text_end when content is empty or whitespace', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire(makeMessageUpdateEvent({ type: 'text_end', content: '   ' }));
    fire(makeMessageUpdateEvent({ type: 'text_end', content: '' }));
    fire(makeMessageUpdateEvent({ type: 'text_end', content: undefined }));

    expect(chatMessage).not.toHaveBeenCalled();
  });

  // ── tool_execution_start ──────────────────────────────────────────────────

  it('posts tool name with arg hint on tool_execution_start', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Impl WI-3');

    fire({
      type: 'tool_execution_start',
      toolName: 'edit_file',
      args: { file_path: 'src/auth.ts', content: 'export function login() {}' },
    });

    expect(chatMessage).toHaveBeenCalledOnce();
    const posted = chatMessage.mock.calls[0][0] as string;
    expect(posted).toContain('[Impl WI-3]');
    expect(posted).toContain('`edit_file`');
    expect(posted).toContain('src/auth.ts');
  });

  it('truncates long tool args to 60 chars', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'a'.repeat(120) },
    });

    const posted = chatMessage.mock.calls[0][0] as string;
    // arg hint should be truncated — message shouldn't contain 120 'a's
    expect(posted).not.toContain('a'.repeat(120));
    expect(posted).toContain('…');
  });

  it('posts tool name without arg hint when args are absent', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');

    fire({ type: 'tool_execution_start', toolName: 'list_files', args: {} });

    const posted = chatMessage.mock.calls[0][0] as string;
    expect(posted).toContain('`list_files`');
    expect(posted).not.toContain(':');
  });

  // ── unrelated events are ignored ─────────────────────────────────────────

  it('ignores unrecognised event types', () => {
    const { session, fire } = makeMockSession();
    (executor as any).subscribeToSession(session, 'Label');
    chatMessage.mockClear();

    fire({ type: 'agent_start' });
    fire({ type: 'turn_end' });
    fire({ type: 'compaction_start', reason: 'threshold' });

    expect(chatMessage).not.toHaveBeenCalled();
  });
});

// ---------- chatMessage wiring in startNew ----------

describe('WorkflowExecutor.startNew — chatMessage wiring', () => {
  let projectDir: string;
  let state: StateManager;
  let chatMessage: ReturnType<typeof vi.fn>;
  let executor: WorkflowExecutor;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-chat-test-'));
    state = new StateManager(projectDir);
    chatMessage = vi.fn();
    executor = new WorkflowExecutor(state, makeModelRouter(), { chatMessage });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('posts an error message and throws when input looks like an epic ref but no WorkItems dir exists', async () => {
    await expect(executor.startNew('1')).rejects.toThrow(/No WorkItems directory found/);
    expect(chatMessage).toHaveBeenCalledOnce();
    expect(chatMessage.mock.calls[0][0]).toMatch(/No WorkItems directory found/);
  });

  it('posts task checklist after subtasks are loaded from a pre-planned epic', async () => {
    const { EpicLoader } = await import('../../src/orchestrator/epic-loader.js');
    (EpicLoader as any).mockImplementation(function () {
      return {
        findEpic: vi.fn().mockReturnValue('/fake/epic-01.md'),
        parseEpic: vi.fn().mockReturnValue({
          title: 'Auth Epic',
          summary: 'Auth',
          dependencies: [],
          architecturalDecisions: [],
          workItems: [
            { id: 'WI-1', title: 'Login', description: 'Implement login' },
            { id: 'WI-2', title: 'Logout', description: 'Implement logout' },
          ],
        }),
      };
    });

    // Prevent processQueue from actually running
    (executor as any).processQueue = vi.fn().mockResolvedValue(undefined);

    await executor.startNew('1');

    const checklistCall = chatMessage.mock.calls.find(
      (c: any[]) => (c[0] as string).includes('📋')
    );
    expect(checklistCall).toBeDefined();
    const msg = checklistCall![0] as string;
    expect(msg).toContain('2 tasks');
    expect(msg).toContain('WI-1');
    expect(msg).toContain('WI-2');
  });
});

// ---------- stop-on-failure and resume ----------

describe('WorkflowExecutor — stop-on-failure and resume', () => {
  let projectDir: string;
  let state: StateManager;
  let executor: WorkflowExecutor;
  let restoreSetTimeout: () => void;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-resume-test-'));
    state = new StateManager(projectDir);
    executor = new WorkflowExecutor(state, makeModelRouter());

    // Eliminate slot-recovery delays: make setTimeout resolve immediately
    const realSetTimeout = global.setTimeout;
    const fakeSetTimeout = (fn: (...args: any[]) => void, _delay?: number, ...args: any[]) => {
      return realSetTimeout(fn, 0, ...args);
    };
    (global as any).setTimeout = fakeSetTimeout;
    restoreSetTimeout = () => { (global as any).setTimeout = realSetTimeout; };
  });

  afterEach(() => {
    restoreSetTimeout?.();
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('resume throws when no workflow state exists', async () => {
    await expect(executor.resume()).rejects.toThrow(/No workflow state found/);
  });

  it('resume(false) calls processQueue without resetting failed tasks', async () => {
    state.initWorkflow('test');
    state.setSubtasks([{ id: 'WI-1', description: 'Task' }]);
    state.updateSubtask('WI-1', { status: 'failed' });

    (executor as any).processQueue = vi.fn().mockResolvedValue(undefined);
    const resetFailed = vi.spyOn(state, 'resetFailedTasks');

    await executor.resume(false);

    expect(resetFailed).not.toHaveBeenCalled();
    expect((executor as any).processQueue).toHaveBeenCalledOnce();
  });

  it('resume(true) resets failed tasks before calling processQueue', async () => {
    state.initWorkflow('test');
    state.setSubtasks([{ id: 'WI-1', description: 'Task' }]);
    state.updateSubtask('WI-1', { status: 'failed' });

    (executor as any).processQueue = vi.fn().mockResolvedValue(undefined);
    const resetFailed = vi.spyOn(state, 'resetFailedTasks');

    await executor.resume(true);

    expect(resetFailed).toHaveBeenCalledOnce();
    expect((executor as any).processQueue).toHaveBeenCalledOnce();
    // After retry, WI-1 should be back to pending
    expect(state.getSubtask('WI-1')?.status).toBe('pending');
  });

  it('processQueue stops after first task failure and emits taskFailed', async () => {
    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates, formatGateFailures } = await import('../../src/orchestrator/quality-gates.js');

    state.initWorkflow('epic-1');
    state.setSubtasks([
      { id: 'WI-1', description: 'Task one' },
      { id: 'WI-2', description: 'Task two' },
    ]);

    const { session } = makeMockSession();
    (createSubAgentSession as any).mockResolvedValue(session);

    // Gates always fail → exhausts MAX_ATTEMPTS.
    // Baseline (first call) passes so the per-task tsc failure is not treated as pre-existing.
    // Per-task calls include a blocking gate so newBlockingFailures.length > 0 and the task
    // truly fails rather than being skipped as "all pre-existing baseline failures".
    (runQualityGates as any)
      .mockResolvedValueOnce({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined }) // baseline
      .mockResolvedValue({  // per-task calls
        allBlockingPassed: false,
        gates: [{ gate: 'tsc', passed: false, blocking: true }],
        testMetrics: undefined,
        coverageMetrics: undefined,
      });
    (formatGateFailures as any).mockReturnValue('tsc errors');

    const failed: string[] = [];
    executor.events.on('taskFailed', (e: any) => failed.push(e.id));

    // planAndBreakdown is called in refineTaskIntoSubtasks — make it return nothing useful
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task one', subtasks: [] });

    await (executor as any).processQueue();

    // Only WI-1 should have been attempted — WI-2 stays pending because workflow stops
    expect(failed).toEqual(['WI-1']);
    expect(state.getSubtask('WI-1')?.status).toBe('failed');
    expect(state.getSubtask('WI-2')?.status).toBe('pending');
  });

  it('processQueue posts failure chatMessage with resume instructions', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates, formatGateFailures } = await import('../../src/orchestrator/quality-gates.js');

    state.initWorkflow('2');
    state.setSubtasks([{ id: 'WI-1', description: 'Failing task' }]);

    const { session } = makeMockSession();
    (createSubAgentSession as any).mockResolvedValue(session);
    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: false, gates: [], testMetrics: undefined, coverageMetrics: undefined });
    (formatGateFailures as any).mockReturnValue('gate failure details');

    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Failing task', subtasks: [] });

    await (executor as any).processQueue();

    // The final task-failure message contains the resume instructions
    const failureMsg = chatMessage.mock.calls.find(
      (c: any[]) => (c[0] as string).includes('/tdd 2 retry')
    );
    expect(failureMsg).toBeDefined();
    const msg = failureMsg![0] as string;
    expect(msg).toContain('WI-1');
    expect(msg).toContain('/tdd 2 retry');
    expect(msg).toContain('/tdd 2 continue');
    expect(msg).toContain('Inspect:');
  });

  it('processQueue passes git diff and changed files to reviewer prompt', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');

    state.initWorkflow('epic-diff');
    state.setSubtasks([{ id: 'WI-1', description: 'Diff task' }]);

    // Git diff returns a real-looking diff
    (execFileAsync as any).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args.includes('--name-only')) return { stdout: 'src/foo.ts\n', stderr: '' };
      return { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n+added line\n', stderr: '' };
    });

    const reviewText = 'APPROVED: true\nFEEDBACK: Looks good';
    let reviewerPromptArg = '';
    const { session: implSession } = makeMockSession();
    const { session: reviewerSession, fire: fireReviewer } = makeMockSession();
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return implSession;
      reviewerSession.prompt = vi.fn().mockImplementation(async (prompt: string) => {
        reviewerPromptArg = prompt;
        fireReviewer({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reviewText }] } });
      });
      return reviewerSession;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined });
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Diff task', subtasks: [] });

    await (executor as any).processQueue();

    expect(reviewerPromptArg).toContain('src/foo.ts');
    expect(reviewerPromptArg).toContain('+added line');
    expect(reviewerPromptArg).toContain('Changed Files');
    expect(reviewerPromptArg).toContain('Diff');
  });

  it('processQueue includes implementation-notes.md content in reviewer prompt when the file exists', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });

    state.initWorkflow('epic-notes');
    state.setSubtasks([{ id: 'WI-1', description: 'Notes task' }]);

    const reviewText = 'APPROVED: true\nFEEDBACK: Great';
    let reviewerPromptArg = '';
    const { session: implSession } = makeMockSession();
    const { session: reviewerSession, fire: fireReviewer } = makeMockSession();
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Simulate the implementer writing implementation notes during its session.
        // Notes are cleared at the start of the implementing phase, so they must be
        // written by the implementer itself (not pre-created before processQueue runs).
        implSession.prompt = vi.fn().mockImplementation(async () => {
          const tddDir = path.join(projectDir, '.tdd-workflow');
          fs.mkdirSync(tddDir, { recursive: true });
          fs.writeFileSync(path.join(tddDir, 'implementation-notes.md'), 'Chose approach X because Y. Trade-off: Z.');
        });
        return implSession;
      }
      reviewerSession.prompt = vi.fn().mockImplementation(async (prompt: string) => {
        reviewerPromptArg = prompt;
        fireReviewer({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reviewText }] } });
      });
      return reviewerSession;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined });
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Notes task', subtasks: [] });

    await (executor as any).processQueue();

    expect(reviewerPromptArg).toContain('Implementer Notes');
    expect(reviewerPromptArg).toContain('Chose approach X because Y');
  });

  it('processQueue omits Implementer Notes section when notes file is absent', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });

    state.initWorkflow('epic-nonotes');
    state.setSubtasks([{ id: 'WI-1', description: 'No-notes task' }]);

    const reviewText = 'APPROVED: true\nFEEDBACK: Fine';
    let reviewerPromptArg = '';
    const { session: implSession } = makeMockSession();
    const { session: reviewerSession, fire: fireReviewer } = makeMockSession();
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return implSession;
      reviewerSession.prompt = vi.fn().mockImplementation(async (prompt: string) => {
        reviewerPromptArg = prompt;
        fireReviewer({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reviewText }] } });
      });
      return reviewerSession;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined });
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'No-notes task', subtasks: [] });

    await (executor as any).processQueue();

    expect(reviewerPromptArg).not.toContain('Implementer Notes');
  });

  it('collectAgentQuestions returns null when questions.md does not exist', async () => {
    const result = await (executor as any).collectAgentQuestions('Implementer WI-1');
    expect(result).toBeNull();
  });

  it('collectAgentQuestions posts questions to chat and waits for input when file exists', async () => {
    const chatMessage = vi.fn();
    const waitForInput = vi.fn().mockResolvedValue('Use soft-delete. UUID for new records.');
    (executor as any).chatMessage = chatMessage;
    (executor as any).waitForInput = waitForInput;

    const tddDir = path.join(projectDir, '.tdd-workflow');
    fs.mkdirSync(tddDir, { recursive: true });
    fs.writeFileSync(path.join(tddDir, 'questions.md'), '1. Soft-delete or hard-delete?\n2. UUID or sequential IDs?');

    const result = await (executor as any).collectAgentQuestions('Implementer WI-1');

    expect(chatMessage).toHaveBeenCalledOnce();
    expect(chatMessage.mock.calls[0][0]).toContain('Soft-delete or hard-delete');
    expect(waitForInput).toHaveBeenCalledOnce();
    expect(result).toContain('Use soft-delete');
    expect(result).toContain('User answers to agent questions');

    // File should be deleted after reading
    expect(fs.existsSync(path.join(tddDir, 'questions.md'))).toBe(false);
  });

  it('collectAgentQuestions returns null when user cancels (waitForInput returns null)', async () => {
    const waitForInput = vi.fn().mockResolvedValue(null);
    (executor as any).waitForInput = waitForInput;

    const tddDir = path.join(projectDir, '.tdd-workflow');
    fs.mkdirSync(tddDir, { recursive: true });
    fs.writeFileSync(path.join(tddDir, 'questions.md'), '1. What should I do?');

    const result = await (executor as any).collectAgentQuestions('Implementer WI-1');
    expect(result).toBeNull();
  });

  it('collectAgentQuestions logs a warning and skips when no waitForInput is wired', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;
    (executor as any).waitForInput = null;

    const tddDir = path.join(projectDir, '.tdd-workflow');
    fs.mkdirSync(tddDir, { recursive: true });
    fs.writeFileSync(path.join(tddDir, 'questions.md'), '1. No handler configured');

    const result = await (executor as any).collectAgentQuestions('Implementer WI-1');

    expect(result).toBeNull();
    // Should still post the questions to chat as an informational message
    expect(chatMessage).toHaveBeenCalledOnce();
    expect(chatMessage.mock.calls[0][0]).toContain('no input handler');
  });

  it('processQueue captures reviewText from text_end stream events (reasoning model path)', async () => {
    // Reasoning models emit text via text_end stream events rather than populating
    // message_end content — verify the executor uses accumulated stream text for verdict parsing.
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });

    state.initWorkflow('epic-stream');
    state.setSubtasks([{ id: 'WI-1', description: 'Stream review task' }]);

    const { session: implSession } = makeMockSession();
    const { session: reviewerSession, fire: fireReviewer } = makeMockSession();
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return implSession;
      reviewerSession.prompt = vi.fn().mockImplementation(async () => {
        // Emit text via message_update/text_end (stream path) — no message_end content
        fireReviewer({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: true\nFEEDBACK: Streaming verdict' } });
        // message_end with EMPTY content array (reasoning model behaviour)
        fireReviewer({ type: 'message_end', message: { role: 'assistant', content: [] } });
      });
      return reviewerSession;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined });
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Stream review task', subtasks: [] });

    await (executor as any).processQueue();

    // Task should be completed — the streaming text_end path parsed APPROVED: true
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
  });

  it('processQueue posts completion chatMessage on success', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');

    state.initWorkflow('epic-3');
    state.setSubtasks([{ id: 'WI-1', description: 'Succeeding task' }]);

    // Session that produces APPROVED review text
    const reviewText = 'APPROVED: true\nFEEDBACK: Great job';
    const { session: implementerSession } = makeMockSession();
    const { session: reviewerSession, fire: fireReviewerEvent } = makeMockSession();

    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Implementer
        return implementerSession;
      }
      // Reviewer — fire message_end with review text after prompt
      reviewerSession.prompt = vi.fn().mockImplementation(async () => {
        fireReviewerEvent({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: reviewText }],
          },
        });
      });
      return reviewerSession;
    });

    (runQualityGates as any).mockResolvedValue({
      allBlockingPassed: true,
      gates: [{ gate: 'typescript', passed: true, blocking: true }],
      testMetrics: { passed: 5, failed: 0, total: 5 },
      coverageMetrics: undefined,
    });

    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Succeeding task', subtasks: [] });

    await (executor as any).processQueue();

    // After completion, postChecklistUpdate fires — find a message with ✅ WI-1
    const checklistMsg = chatMessage.mock.calls.find(
      (c: any[]) => (c[0] as string).includes('✅') && (c[0] as string).includes('WI-1')
    );
    expect(checklistMsg).toBeDefined();
    expect(checklistMsg![0]).toContain('Progress');
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
  });

  it('deferred review: per-task reviewer is skipped for multi-task workflows', async () => {
    // With 2+ subtasks, no per-task reviewer should be created.
    // The createSubAgentSession call count should equal the number of implementer sessions only.
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });

    state.initWorkflow('epic-deferred');
    state.setSubtasks([
      { id: 'WI-1', description: 'Task one' },
      { id: 'WI-2', description: 'Task two' },
    ]);

    const sessionCreations: string[] = [];
    const { session: impl1 } = makeMockSession();
    const { session: impl2 } = makeMockSession();
    const { session: finalReviewer, fire: fireFinalReviewer } = makeMockSession();
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      callCount++;
      if (opts.taskType === 'implement') {
        sessionCreations.push('implementer');
        return callCount === 1 ? impl1 : impl2;
      }
      // taskType === 'review' → final reviewer
      sessionCreations.push('reviewer');
      finalReviewer.prompt = vi.fn().mockImplementation(async () => {
        fireFinalReviewer({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: true\nFEEDBACK: All good' } });
      });
      return finalReviewer;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    await (executor as any).processQueue();

    // Two implementer sessions, then one final reviewer — no per-task reviewers
    expect(sessionCreations).toEqual(['implementer', 'implementer', 'reviewer']);
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
    expect(state.getSubtask('WI-2')?.status).toBe('completed');
  });

  it('deferred review: final reviewer receives cumulative diff and approved message is posted to chat', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });

    // Simulate git: rev-parse for start SHA, then diff output for the final review.
    // Per-task diffs use 'HEAD'; final-review diffs use the captured SHA 'abc123'.
    (execFileAsync as any).mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return { stdout: 'abc123', stderr: '' };
      // git diff abc123 (cumulative, no --name-only)
      if (args[0] === 'diff' && args.includes('abc123') && !args.includes('--name-only')) return { stdout: '+cumulative change', stderr: '' };
      // git diff --name-only abc123 (cumulative, with --name-only)
      if (args[0] === 'diff' && args.includes('abc123') && args.includes('--name-only')) return { stdout: 'src/foo.ts', stderr: '' };
      return { stdout: '', stderr: '' };
    });

    state.initWorkflow('epic-cumulative');
    state.setSubtasks([
      { id: 'WI-1', description: 'Task one' },
      { id: 'WI-2', description: 'Task two' },
    ]);

    const { session: impl1 } = makeMockSession();
    const { session: impl2 } = makeMockSession();
    const { session: finalReviewer, fire: fireFinalReviewer } = makeMockSession();
    let finalReviewerPromptArg = '';
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      callCount++;
      if (opts.taskType === 'implement') return callCount === 1 ? impl1 : impl2;
      finalReviewer.prompt = vi.fn().mockImplementation(async (prompt: string) => {
        finalReviewerPromptArg = prompt;
        fireFinalReviewer({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: true\nFEEDBACK: Looks great overall' } });
      });
      return finalReviewer;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    await (executor as any).processQueue();

    // Final reviewer prompt should contain cumulative diff from workflowStartSha
    expect(finalReviewerPromptArg).toContain('Cumulative Diff');
    expect(finalReviewerPromptArg).toContain('+cumulative change');
    expect(finalReviewerPromptArg).toContain('src/foo.ts');

    // Approved message should be posted to chat
    const approvedMsg = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('Final Review Approved'));
    expect(approvedMsg).toBeDefined();
  });

  it('deferred review: advisory warning posted when final reviewer rejects (changes already merged)', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });

    state.initWorkflow('epic-advisory');
    state.setSubtasks([
      { id: 'WI-1', description: 'Task one' },
      { id: 'WI-2', description: 'Task two' },
    ]);

    const { session: impl1 } = makeMockSession();
    const { session: impl2 } = makeMockSession();
    const { session: finalReviewer, fire: fireFinalReviewer } = makeMockSession();
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      callCount++;
      if (opts.taskType === 'implement') return callCount === 1 ? impl1 : impl2;
      finalReviewer.prompt = vi.fn().mockImplementation(async () => {
        fireFinalReviewer({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: false\nFEEDBACK: Missing error handling in foo.ts' } });
      });
      return finalReviewer;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    await (executor as any).processQueue();

    // Both tasks should still be completed (quality gates passed)
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
    expect(state.getSubtask('WI-2')?.status).toBe('completed');

    // Advisory warning should be posted (not a hard failure)
    const warningMsg = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('Final Review: concerns raised'));
    expect(warningMsg).toBeDefined();
    expect(warningMsg![0]).toContain('Missing error handling');
    expect(warningMsg![0]).toContain('All changes have been merged');
  });

  // ── Arbiter tests ──────────────────────────────────────────────────────────

  it('arbiter approves task after MAX_ATTEMPTS when QA passed and reviewer was too strict', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates, formatGateFailures } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });

    // Single-subtask → per-task review runs (no deferReview)
    state.initWorkflow('epic-arbiter-approve');
    state.setSubtasks([{ id: 'WI-1', description: 'Fix the thing' }]);

    // QA always passes; reviewer always rejects (stubborn reviewer)
    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    const { session: implSession } = makeMockSession();
    const { session: reviewerSession, fire: fireReviewer } = makeMockSession();
    const { session: arbiterSession, fire: fireArbiter } = makeMockSession();
    let callCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      callCount++;
      if (opts.taskType === 'implement') return implSession;
      if (opts.taskType === 'review') {
        reviewerSession.prompt = vi.fn().mockImplementation(async () => {
          fireReviewer({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: false\nFEEDBACK: Not happy with style' } });
        });
        return reviewerSession;
      }
      // taskType === 'arbitrate'
      arbiterSession.prompt = vi.fn().mockImplementation(async () => {
        fireArbiter({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'DECISION: approve\nRATIONALE: Reviewer is being overly strict about style; QA passed.' } });
      });
      return arbiterSession;
    });

    await (executor as any).processQueue();

    // Arbiter approved → task completed despite 5 reviewer rejections
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
    const arbiterMsg = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('Arbiter'));
    expect(arbiterMsg).toBeDefined();
  });

  it('arbiter grants extra rounds and task completes in the additional attempt', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });

    state.initWorkflow('epic-arbiter-continue');
    state.setSubtasks([{ id: 'WI-1', description: 'Fix the thing' }]);
    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    const { session: implSession } = makeMockSession();
    const { session: arbiterSession, fire: fireArbiter } = makeMockSession();
    let reviewCallCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      if (opts.taskType === 'implement') return implSession;
      if (opts.taskType === 'arbitrate') {
        arbiterSession.prompt = vi.fn().mockImplementation(async () => {
          fireArbiter({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'DECISION: continue\nROUNDS: 1\nRATIONALE: One more attempt should fix the remaining issue.' } });
        });
        return arbiterSession;
      }
      // reviewer: reject for first 5 calls (normal rounds), approve on call 6 (extra round)
      reviewCallCount++;
      const { session: rev, fire: fireRev } = makeMockSession();
      const approveThisOne = reviewCallCount > 5;
      rev.prompt = vi.fn().mockImplementation(async () => {
        const verdict = approveThisOne ? 'APPROVED: true\nFEEDBACK: Good now' : 'APPROVED: false\nFEEDBACK: Still issues';
        fireRev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: verdict } });
      });
      return rev;
    });

    await (executor as any).processQueue();

    expect(state.getSubtask('WI-1')?.status).toBe('completed');
  });

  it('arbiter escalates to user who stops: task is marked failed', async () => {
    const chatMessage = vi.fn();
    const waitForInput = vi.fn().mockResolvedValue('stop');
    (executor as any).chatMessage = chatMessage;
    (executor as any).waitForInput = waitForInput;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });

    state.initWorkflow('epic-arbiter-escalate');
    state.setSubtasks([{ id: 'WI-1', description: 'Fix the thing' }]);
    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    const { session: implSession } = makeMockSession();
    const { session: arbiterSession, fire: fireArbiter } = makeMockSession();
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      if (opts.taskType === 'implement') return implSession;
      if (opts.taskType === 'arbitrate') {
        arbiterSession.prompt = vi.fn().mockImplementation(async () => {
          fireArbiter({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'DECISION: escalate\nRATIONALE: Needs human judgment.' } });
        });
        return arbiterSession;
      }
      const { session: rev, fire: fireRev } = makeMockSession();
      rev.prompt = vi.fn().mockImplementation(async () => {
        fireRev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: false\nFEEDBACK: Rejected' } });
      });
      return rev;
    });

    const failed: string[] = [];
    executor.events.on('taskFailed', (e: any) => failed.push(e.id));

    await (executor as any).processQueue();

    expect(failed).toContain('WI-1');
    expect(state.getSubtask('WI-1')?.status).toBe('failed');
    // User was consulted
    expect(waitForInput).toHaveBeenCalled();
  });
});

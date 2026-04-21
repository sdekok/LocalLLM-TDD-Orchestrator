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

  // ── no chat posting when chatMessage is absent, but accumulator still works ─

  it('does not post to chatMessage when chatMessage is null, but still accumulates text for getTurnText()', () => {
    const { session, fire } = makeMockSession();
    (executor as any).chatMessage = null;
    const handle = (executor as any).subscribeToSession(session, 'Label');

    // Subscribe must still happen — the helper owns the text accumulator,
    // which reviewer/arbiter rely on to parse verdicts even when chat streaming is off.
    expect(session.subscribe).toHaveBeenCalledOnce();

    fire(makeMessageUpdateEvent({ type: 'thinking_start' }));
    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'APPROVED: true' }));

    // chatMessage must not have been invoked
    expect(chatMessage).not.toHaveBeenCalled();
    // But the accumulator captured the text
    expect(handle.getTurnText()).toBe('APPROVED: true');
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

  // ── handle API: getTurnText / resetTurnText / dispose ────────────────────

  it('handle.getTurnText accumulates text_end content across multiple stream events', () => {
    const { session, fire } = makeMockSession();
    const handle = (executor as any).subscribeToSession(session, 'L');

    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'DONE: part one.' }));
    fire(makeMessageUpdateEvent({ type: 'text_end', content: ' And also part two.' }));

    expect(handle.getTurnText()).toBe('DONE: part one. And also part two.');
  });

  it('handle.resetTurnText clears accumulated text for the next turn', () => {
    const { session, fire } = makeMockSession();
    const handle = (executor as any).subscribeToSession(session, 'L');

    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'turn one' }));
    expect(handle.getTurnText()).toBe('turn one');

    handle.resetTurnText();
    expect(handle.getTurnText()).toBe('');

    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'turn two' }));
    expect(handle.getTurnText()).toBe('turn two');
  });

  it('handle.dispose stops further events from mutating state or reaching chatMessage', () => {
    const { session, fire } = makeMockSession();
    const handle = (executor as any).subscribeToSession(session, 'L');

    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'before dispose' }));
    handle.dispose();
    chatMessage.mockClear();

    // Post-dispose: any events must be no-ops
    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'after dispose' }));
    fire({ type: 'tool_execution_start', toolName: 'edit', args: { path: 'x' } });

    expect(chatMessage).not.toHaveBeenCalled();
    expect(handle.getTurnText()).toBe('before dispose');
  });

  it('handle falls back to message_end content when no text_end has fired yet', () => {
    // Non-streaming SDK path: some sessions publish the final text only via
    // message_end.message.content — the helper must pick it up as a fallback.
    const { session, fire } = makeMockSession();
    const handle = (executor as any).subscribeToSession(session, 'L');

    fire({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'APPROVED: true\nFEEDBACK: ok' }],
      },
    });

    expect(handle.getTurnText()).toContain('APPROVED: true');
  });

  it('handle does NOT overwrite text_end accumulator from message_end (streaming path wins)', () => {
    // Reasoning-model path: text_end streams the real content, message_end.message.content
    // may be empty. Ensure text_end's accumulated value is preserved.
    const { session, fire } = makeMockSession();
    const handle = (executor as any).subscribeToSession(session, 'L');

    fire(makeMessageUpdateEvent({ type: 'text_end', content: 'streamed verdict' }));
    fire({ type: 'message_end', message: { role: 'assistant', content: [] } });

    expect(handle.getTurnText()).toBe('streamed verdict');
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

  it('resume("skip") calls processQueue without resetting failed tasks', async () => {
    state.initWorkflow('test');
    state.setSubtasks([{ id: 'WI-1', description: 'Task' }]);
    state.updateSubtask('WI-1', { status: 'failed' });

    (executor as any).processQueue = vi.fn().mockResolvedValue(undefined);
    const resetFailed = vi.spyOn(state, 'resetFailedTasks');
    const resumeFailed = vi.spyOn(state, 'resumeFailedTasks');

    await executor.resume('skip');

    expect(resetFailed).not.toHaveBeenCalled();
    expect(resumeFailed).not.toHaveBeenCalled();
    expect((executor as any).processQueue).toHaveBeenCalledOnce();
  });

  it('resume("retry") resets failed tasks (clears feedback) before calling processQueue', async () => {
    state.initWorkflow('test');
    state.setSubtasks([{ id: 'WI-1', description: 'Task' }]);
    state.updateSubtask('WI-1', { status: 'failed', feedback: 'old feedback' });

    (executor as any).processQueue = vi.fn().mockResolvedValue(undefined);
    const resetFailed = vi.spyOn(state, 'resetFailedTasks');

    await executor.resume('retry');

    expect(resetFailed).toHaveBeenCalledOnce();
    expect((executor as any).processQueue).toHaveBeenCalledOnce();
    // After retry, WI-1 should be back to pending with feedback cleared
    expect(state.getSubtask('WI-1')?.status).toBe('pending');
    expect(state.getSubtask('WI-1')?.feedback).toBeUndefined();
  });

  it('resume("resume") resets failed tasks but preserves feedback', async () => {
    state.initWorkflow('test');
    state.setSubtasks([{ id: 'WI-1', description: 'Task' }]);
    state.updateSubtask('WI-1', { status: 'failed', feedback: 'reviewer said X' });

    (executor as any).processQueue = vi.fn().mockResolvedValue(undefined);
    const resumeFailed = vi.spyOn(state, 'resumeFailedTasks');

    await executor.resume('resume');

    expect(resumeFailed).toHaveBeenCalledOnce();
    expect((executor as any).processQueue).toHaveBeenCalledOnce();
    // After resume, WI-1 should be pending but feedback preserved
    expect(state.getSubtask('WI-1')?.status).toBe('pending');
    expect(state.getSubtask('WI-1')?.feedback).toBe('reviewer said X');
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

  it('per-task review: each story gets its own reviewer before merging', async () => {
    // Every WI task should run: implementer → reviewer → merge.
    // A final workflow review also runs after all tasks complete.
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
    let reviewerCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      if (opts.taskType === 'implement') {
        sessionCreations.push('implementer');
        return reviewerCount === 0 ? impl1 : impl2;
      }
      // taskType === 'review'
      sessionCreations.push('reviewer');
      reviewerCount++;
      const { session: rev, fire: fireRev } = makeMockSession();
      rev.prompt = vi.fn().mockImplementation(async () => {
        fireRev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: true\nFEEDBACK: All good' } });
      });
      return rev;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    await (executor as any).processQueue();

    // Two tasks → two implementers + two per-task reviewers + one final reviewer
    expect(sessionCreations).toEqual(['implementer', 'reviewer', 'implementer', 'reviewer', 'reviewer']);
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
    expect(state.getSubtask('WI-2')?.status).toBe('completed');
  });

  it('final review: runs after all tasks complete and receives cumulative diff', async () => {
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
      if (args[0] === 'diff' && args.includes('abc123') && !args.includes('--name-only')) return { stdout: '+cumulative change', stderr: '' };
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
    let finalReviewerPromptArg = '';
    let implCount = 0;
    let reviewCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      if (opts.taskType === 'implement') {
        return implCount++ === 0 ? impl1 : impl2;
      }
      // Per-task reviewers approve; track only the last (final) reviewer's prompt
      const { session: rev, fire: fireRev } = makeMockSession();
      const isLastReview = reviewCount++ === 2; // 0 and 1 are per-task; 2 is final
      rev.prompt = vi.fn().mockImplementation(async (prompt: string) => {
        if (isLastReview) finalReviewerPromptArg = prompt;
        fireRev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'APPROVED: true\nFEEDBACK: Looks great overall' } });
      });
      return rev;
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

  it('final review: advisory warning posted when final reviewer rejects (changes already merged)', async () => {
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
    let implCount = 0;
    let reviewCount = 0;
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      if (opts.taskType === 'implement') return implCount++ === 0 ? impl1 : impl2;
      // Per-task reviewers approve; final reviewer rejects (advisory)
      const isLastReview = reviewCount++ === 2;
      const { session: rev, fire: fireRev } = makeMockSession();
      rev.prompt = vi.fn().mockImplementation(async () => {
        const verdict = isLastReview
          ? 'APPROVED: false\nFEEDBACK: Missing error handling in foo.ts'
          : 'APPROVED: true\nFEEDBACK: All good';
        fireRev({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: verdict } });
      });
      return rev;
    });

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });

    await (executor as any).processQueue();

    // Both tasks should still be completed (per-task reviewers approved, final is advisory only)
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

  // ─── Pause / Stop tests ────────────────────────────────────────────────────

  it('requestPause: finishes the current implementer prompt, marks task paused, preserves attempts + branch', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });

    state.initWorkflow('epic-pause');
    state.setSubtasks([{ id: 'WI-1', description: 'Paused task' }]);

    const paused: any[] = [];
    executor.events.on('taskPaused', (e: any) => paused.push(e));

    const { session: implSession } = makeMockSession();
    implSession.prompt = vi.fn().mockImplementation(async () => {
      // While the prompt is "running", the user requests a pause.
      executor.requestPause();
    });
    (createSubAgentSession as any).mockImplementation(async (opts: any) => {
      if (opts.taskType === 'implement') return implSession;
      // Any reviewer/arbiter spawning would be a failure — pause should exit first.
      throw new Error(`unexpected ${opts.taskType} session after pause`);
    });
    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined });

    await (executor as any).processQueue();

    const task = state.getSubtask('WI-1')!;
    expect(task.status).toBe('paused');
    expect(task.attempts).toBe(1); // attempt counter preserved
    expect(paused).toHaveLength(1);
    expect(paused[0].id).toBe('WI-1');
    // Chat should confirm pause with /tdd:resume hint. Filter to the explicit
    // pause notification (contains "⏸ **Paused.**"), not the progress
    // checklist which just shows the task status icon.
    const pauseMsg = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('⏸ **Paused.**'));
    expect(pauseMsg).toBeDefined();
    expect(pauseMsg![0]).toContain('resume');
  });

  it('requestStop: aborts implementer session, rolls back branch, resets task to pending with no feedback', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { Sandbox } = await import('../../src/orchestrator/sandbox.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });

    // Seed a feedback + attempts so we can verify the stop resets them.
    state.initWorkflow('epic-stop');
    state.setSubtasks([{ id: 'WI-1', description: 'Stop me' }]);

    const stopped: any[] = [];
    executor.events.on('taskStopped', (e: any) => stopped.push(e));

    const { session: implSession } = makeMockSession();
    let stopRequestedDuringPrompt = false;
    implSession.prompt = vi.fn().mockImplementation(async () => {
      executor.requestStop();
      stopRequestedDuringPrompt = true;
      // In real life stop also disposes the session so prompt would reject.
      // Mock that by throwing to match the production abort path.
      throw new Error('Session disposed');
    });
    (createSubAgentSession as any).mockImplementation(async () => implSession);
    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined });

    await (executor as any).processQueue();

    expect(stopRequestedDuringPrompt).toBe(true);
    const task = state.getSubtask('WI-1')!;
    expect(task.status).toBe('pending');
    expect(task.attempts).toBe(0);       // reset
    expect(task.feedback).toBeUndefined(); // cleared
    expect(stopped).toHaveLength(1);
    // Sandbox rollback should have been invoked (mockSandbox shared instance)
    const mockSandbox: any = (Sandbox as any)();
    expect(mockSandbox.rollback).toHaveBeenCalled();
    // Chat message confirms stop
    const stopMsg = chatMessage.mock.calls.find((c: any[]) => (c[0] as string).includes('Stopped'));
    expect(stopMsg).toBeDefined();
  });

  it('requestPause during a multi-task workflow pauses at the current task and leaves the rest pending', async () => {
    const chatMessage = vi.fn();
    (executor as any).chatMessage = chatMessage;

    const { createSubAgentSession } = await import('../../src/subagent/factory.js');
    const { runQualityGates } = await import('../../src/orchestrator/quality-gates.js');
    const { execFileAsync } = await import('../../src/utils/exec.js');
    const { planAndBreakdown } = await import('../../src/agents/planner.js');
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'T', subtasks: [] });

    state.initWorkflow('multi-pause');
    state.setSubtasks([
      { id: 'WI-1', description: 'a' },
      { id: 'WI-2', description: 'b' },
    ]);

    const { session: impl } = makeMockSession();
    impl.prompt = vi.fn().mockImplementation(async () => {
      executor.requestPause();
    });
    (createSubAgentSession as any).mockImplementation(async () => impl);
    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined });

    await (executor as any).processQueue();

    expect(state.getSubtask('WI-1')?.status).toBe('paused');
    expect(state.getSubtask('WI-2')?.status).toBe('pending'); // never started
  });

  it('isInterrupted reflects pending pause/stop state', () => {
    expect(executor.isInterrupted()).toBe(false);
    executor.requestPause();
    expect(executor.isInterrupted()).toBe(true);
  });

  it('requestPause is ignored when stop is already pending (stop wins)', () => {
    executor.requestStop();
    expect(executor.isInterrupted()).toBe(true);
    // Attempting pause after stop should be a no-op — state still reflects stop,
    // not pause. We verify by kicking off processQueue with a paused task setup
    // and expecting the stop semantics (reset to pending) not pause (keep paused).
    executor.requestPause();
    // Internal flag state — stopRequested stays true
    expect((executor as any).stopRequested).toBe(true);
  });

  it('resume() picks up paused tasks in resume mode (feedback + attempts preserved)', async () => {
    state.initWorkflow('paused-epic');
    state.setSubtasks([{ id: 'WI-1', description: 'Resumed task' }]);
    state.updateSubtask('WI-1', { status: 'paused', attempts: 3, feedback: 'preserve me' });

    (executor as any).processQueue = vi.fn().mockResolvedValue(undefined);

    await executor.resume('skip');

    // Paused task should now be pending with feedback + attempts preserved,
    // and resumeMode should have flipped on so the task branch survives.
    const task = state.getSubtask('WI-1')!;
    expect(task.status).toBe('pending');
    expect(task.attempts).toBe(3);
    expect(task.feedback).toBe('preserve me');
    expect((executor as any).resumeMode).toBe(true);
  });
});

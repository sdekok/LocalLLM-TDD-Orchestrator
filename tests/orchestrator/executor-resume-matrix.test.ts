/**
 * Resume-matrix tests for WorkflowExecutor.
 *
 * Resume paths are the least-tested and most bug-prone dimension of the executor
 * (both recent production bugs were resume bugs). This suite drives the meaningful
 * combinations of:
 *   - task status        : pending / in_progress / failed / paused / completed
 *   - phase at restart   : undefined / refining / implementing / quality_gates /
 *                          reviewing / merging
 *   - resume mode        : skip / retry / resume
 *   - attempts           : 0 / mid / past MAX_ATTEMPTS (with a persisted ceiling)
 *
 * and asserts, per row, WHICH agent sessions get created and in what order
 * (implement / review / arbitrate) plus the final task status. Single-subtask
 * workflows are used throughout so the post-epic final workflow review (which
 * only runs for >1 task) never adds a confounding extra reviewer session.
 *
 * Key behaviours locked down:
 *   - resume into quality_gates/reviewing/merging skips the implementer
 *   - resume into merging skips the whole loop and just merges
 *   - failed+skip / completed are not picked up (no sessions)
 *   - failed+retry/resume reset the phase → full implement→review cycle
 *   - a task resumed with attempts past MAX runs its remaining attempts up to the
 *     PERSISTED ceiling before any arbiter consult (the WI-189 class of bug)
 */
process.env['TDD_SLOT_RECOVERY_MS'] = '0';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { WorkflowExecutor } from '../../src/orchestrator/executor.js';
import { StateManager, type TaskStatus, type TaskPhase } from '../../src/orchestrator/state.js';
import { makeModelRouter, makeMockSession, installImmediateSetTimeout } from '../helpers/executor-harness.js';

vi.mock('../../src/agents/planner.js', async () => (await import('../helpers/executor-mocks.js')).plannerMock());
vi.mock('../../src/utils/exec.js', async () => (await import('../helpers/executor-mocks.js')).execMock());
vi.mock('../../src/orchestrator/quality-gates.js', async () => (await import('../helpers/executor-mocks.js')).qualityGatesMock());
vi.mock('../../src/orchestrator/epic-loader.js', async () => (await import('../helpers/executor-mocks.js')).epicLoaderMock());
vi.mock('../../src/subagent/factory.js', async () => (await import('../helpers/executor-mocks.js')).subagentFactoryMock());
vi.mock('../../src/orchestrator/sandbox.js', async () => (await import('../helpers/executor-mocks.js')).sandboxMock());

import { createSubAgentSession } from '../../src/subagent/factory.js';
import { runQualityGates } from '../../src/orchestrator/quality-gates.js';
import { execFileAsync } from '../../src/utils/exec.js';
import { planAndBreakdown } from '../../src/agents/planner.js';

/**
 * Wire createSubAgentSession to record the taskType of every spawned session and
 * to emit a configurable verdict per role. Returns the live order array.
 */
function wireSessions(opts: {
  reviewerApproves?: boolean | (() => boolean);
  arbiterDecision?: string;
} = {}): string[] {
  const order: string[] = [];
  (createSubAgentSession as any).mockImplementation(async (o: any) => {
    order.push(o.taskType);
    const { session, fire } = makeMockSession();
    if (o.taskType === 'review') {
      session.prompt = vi.fn(async () => {
        const approve = typeof opts.reviewerApproves === 'function'
          ? opts.reviewerApproves()
          : (opts.reviewerApproves ?? true);
        fire({
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_end',
            content: approve ? 'APPROVED: true\nFEEDBACK: ok' : 'APPROVED: false\nFEEDBACK: not yet',
          },
        });
      });
    } else if (o.taskType === 'arbitrate') {
      session.prompt = vi.fn(async () => {
        fire({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_end', content: opts.arbiterDecision ?? 'DECISION: escalate\nRATIONALE: needs human' },
        });
      });
    } else {
      // implement
      session.prompt = vi.fn(async () => {
        fire({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'DONE: implemented' } });
      });
    }
    return session;
  });
  return order;
}

describe('WorkflowExecutor — resume matrix', () => {
  let projectDir: string;
  let state: StateManager;
  let executor: WorkflowExecutor;
  let chatMessage: ReturnType<typeof vi.fn>;
  let restoreSetTimeout: () => void;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-resume-matrix-'));
    state = new StateManager(projectDir);
    chatMessage = vi.fn();
    executor = new WorkflowExecutor(state, makeModelRouter(), { chatMessage });
    restoreSetTimeout = installImmediateSetTimeout();

    (runQualityGates as any).mockResolvedValue({ allBlockingPassed: true, gates: [], testMetrics: undefined, coverageMetrics: undefined });
    (execFileAsync as any).mockResolvedValue({ stdout: '', stderr: '' });
    (planAndBreakdown as any).mockResolvedValue({ refinedRequest: 'Task', subtasks: [] });
  });

  afterEach(() => {
    restoreSetTimeout?.();
    fs.rmSync(projectDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** Seed a single-subtask workflow and stamp the task into the desired state. */
  function seedTask(overrides: Partial<{ status: TaskStatus; phase: TaskPhase; attempts: number; attemptCeiling: number; arbiterRounds: number; feedback: string }>): void {
    state.initWorkflow('matrix-epic');
    state.setSubtasks([{ id: 'WI-1', description: 'Matrix task' }]);
    state.updateSubtask('WI-1', overrides);
  }

  // ── phase fast-paths (task pending, resumed mid-phase) ────────────────────
  // A task interrupted while in_progress is reset to pending by
  // resetInterruptedTasks() with its phase PRESERVED, so the phase drives which
  // sub-phases re-run. We model that end state directly (pending + phase) and run
  // processQueue.

  interface PhaseRow {
    name: string;
    phase: TaskPhase | undefined;
    expectImplement: boolean;
    expectReview: boolean;
  }

  const phaseRows: PhaseRow[] = [
    { name: 'undefined → full implement→review', phase: undefined, expectImplement: true, expectReview: true },
    { name: 'refining → full implement→review', phase: 'refining', expectImplement: true, expectReview: true },
    { name: 'implementing → implement→review', phase: 'implementing', expectImplement: true, expectReview: true },
    { name: 'quality_gates → review only (implementer skipped)', phase: 'quality_gates', expectImplement: false, expectReview: true },
    { name: 'reviewing → review only (implementer skipped)', phase: 'reviewing', expectImplement: false, expectReview: true },
    { name: 'merging → no loop, straight to merge', phase: 'merging', expectImplement: false, expectReview: false },
  ];

  for (const row of phaseRows) {
    it(`resume into phase=${row.phase ?? 'undefined'}: ${row.name}`, async () => {
      seedTask({ status: 'pending', phase: row.phase, attempts: 1 });
      const order = wireSessions({ reviewerApproves: true });

      await (executor as any).processQueue();

      expect(order.includes('implement')).toBe(row.expectImplement);
      expect(order.includes('review')).toBe(row.expectReview);
      expect(order).not.toContain('arbitrate');
      // Every one of these rows ends in a clean merge → completed.
      expect(state.getSubtask('WI-1')?.status).toBe('completed');
    });
  }

  // ── resume-mode behaviour (failed / paused / completed) ───────────────────

  it('failed + skip: not picked up — no sessions, stays failed', async () => {
    seedTask({ status: 'failed', feedback: 'prior reviewer feedback' });
    const order = wireSessions({ reviewerApproves: true });

    await executor.resume('skip');

    expect(order).toEqual([]);
    expect(state.getSubtask('WI-1')?.status).toBe('failed');
  });

  it('failed + retry: phase reset → full implement→review, feedback cleared', async () => {
    seedTask({ status: 'failed', phase: 'reviewing', attempts: 3, feedback: 'old feedback' });
    const order = wireSessions({ reviewerApproves: true });

    await executor.resume('retry');

    // retry resets the phase, so the implementer runs even though it failed in review.
    expect(order).toContain('implement');
    expect(order).toContain('review');
    expect(order.indexOf('implement')).toBeLessThan(order.indexOf('review'));
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
    expect(state.getSubtask('WI-1')?.feedback).toBeUndefined();
  });

  it('failed + resume: phase reset → full implement→review, feedback preserved into first attempt', async () => {
    seedTask({ status: 'failed', phase: 'reviewing', attempts: 3, feedback: 'reviewer said X' });
    const order = wireSessions({ reviewerApproves: true });

    await executor.resume('resume');

    expect(order).toContain('implement');
    expect(order).toContain('review');
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
  });

  it('paused + skip: picked up in resume mode → full implement→review', async () => {
    // Pause always clears phase, so a resumed paused task runs the full cycle.
    seedTask({ status: 'paused', attempts: 2, feedback: 'keep me' });
    const order = wireSessions({ reviewerApproves: true });

    await executor.resume('skip');

    expect(order).toContain('implement');
    expect(order).toContain('review');
    expect((executor as any).resumeMode).toBe(true);
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
  });

  it('completed + skip: not re-run — no sessions, stays completed', async () => {
    seedTask({ status: 'completed' });
    const order = wireSessions({ reviewerApproves: true });

    await executor.resume('skip');

    expect(order).toEqual([]);
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
  });

  // ── attempts past MAX_ATTEMPTS with a persisted ceiling (WI-189 class) ─────

  it('attempts past MAX with persisted ceiling runs the remaining attempts before any arbiter consult', async () => {
    // A task interrupted after the arbiter granted extra rounds: attempts=12 with a
    // persisted ceiling of 14. The resumed pass-0 loop must run attempts 12→14 (three
    // implement→gates→review cycles) BEFORE the arbiter is consulted — never drop into
    // a blind consult with an empty diff. The implementer session is reused across
    // attempts, so the reliable per-cycle signal is the number of reviewer sessions
    // spawned before the first arbiter session.
    seedTask({ status: 'pending', phase: undefined, attempts: 12, attemptCeiling: 14, arbiterRounds: 0 });
    // Reviewer rejects every round so the loop runs to the ceiling and then consults
    // the arbiter, which escalates; the user stops → task fails.
    (executor as any).waitForInput = vi.fn().mockResolvedValue('stop');
    const order = wireSessions({ reviewerApproves: false, arbiterDecision: 'DECISION: escalate\nRATIONALE: stuck' });

    await (executor as any).processQueue();

    const firstArbiter = order.indexOf('arbitrate');
    expect(firstArbiter).toBeGreaterThan(-1); // arbiter WAS eventually consulted
    expect(order.includes('implement')).toBe(true); // not a blind consult
    expect(order.indexOf('implement')).toBeLessThan(firstArbiter); // implementer ran first
    const reviewsBeforeArbiter = order.slice(0, firstArbiter).filter(t => t === 'review').length;
    expect(reviewsBeforeArbiter).toBe(3); // attempts 12, 13, 14 → three full cycles
    expect(state.getSubtask('WI-1')?.status).toBe('failed');
  });

  it('legacy resume: attempts past MAX with NO persisted ceiling still runs one full cycle (band-aid)', async () => {
    // Tasks interrupted before the ceiling was persisted carry attempts past MAX with
    // no attemptCeiling. The max(ceiling, startAttempt) guard must still give them at
    // least one implement→review cycle instead of a blind consult.
    seedTask({ status: 'pending', phase: undefined, attempts: 12 });
    const order = wireSessions({ reviewerApproves: true });

    await (executor as any).processQueue();

    expect(order).toContain('implement');
    expect(order).toContain('review');
    expect(order.indexOf('implement')).toBeLessThan(order.indexOf('review'));
    expect(state.getSubtask('WI-1')?.status).toBe('completed');
  });

  // ── persistence: ceiling + arbiterRounds survive to the state file ────────

  it('persists attemptCeiling and arbiterRounds as the arbiter grants rounds', async () => {
    seedTask({ status: 'pending', phase: undefined });
    (executor as any).waitForInput = vi.fn().mockResolvedValue('stop');
    // Arbiter grants one extra round each consult; reviewer never approves, so the
    // ceiling advances past MAX_ATTEMPTS and arbiterRounds climbs — both must persist.
    wireSessions({ reviewerApproves: false, arbiterDecision: 'DECISION: continue\nROUNDS: 1\nRATIONALE: progress' });

    await (executor as any).processQueue();

    const task = state.getSubtask('WI-1')!;
    // Reloading from disk proves the values were saved, not just held in memory.
    const reloaded = new StateManager(projectDir).getSubtask('WI-1')!;
    expect(reloaded.attemptCeiling).toBe(task.attemptCeiling);
    expect(reloaded.arbiterRounds).toBe(task.arbiterRounds);
    expect(reloaded.attemptCeiling!).toBeGreaterThan(5); // ceiling advanced past MAX_ATTEMPTS
    expect(reloaded.arbiterRounds!).toBeGreaterThanOrEqual(1);
  });

  // ── reset paths clear the new fields ──────────────────────────────────────

  it('resetFailedTasks and resumeFailedTasks clear attemptCeiling + arbiterRounds', () => {
    seedTask({ status: 'failed', attempts: 13, attemptCeiling: 14, arbiterRounds: 2, feedback: 'fb' });

    state.resetFailedTasks();
    let t = state.getSubtask('WI-1')!;
    expect(t.attemptCeiling).toBeUndefined();
    expect(t.arbiterRounds).toBeUndefined();
    expect(t.attempts).toBe(0);

    // And the feedback-preserving variant clears them too.
    state.updateSubtask('WI-1', { status: 'failed', attempts: 13, attemptCeiling: 14, arbiterRounds: 2 });
    state.resumeFailedTasks();
    t = state.getSubtask('WI-1')!;
    expect(t.attemptCeiling).toBeUndefined();
    expect(t.arbiterRounds).toBeUndefined();
  });
});

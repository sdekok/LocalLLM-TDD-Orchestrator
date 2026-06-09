import { describe, it, expect } from 'vitest';
import { formatWorkflowStatus } from '../../../src/interfaces/pi/status.js';
import type { WorkflowState, Subtask } from '../../../src/orchestrator/state.js';

function task(overrides: Partial<Subtask> & { id: string }): Subtask {
  return {
    description: `Task ${overrides.id}`,
    status: 'pending',
    tests_written: false,
    code_implemented: false,
    attempts: 0,
    ...overrides,
  };
}

function state(subtasks: Subtask[], extra: Partial<WorkflowState> = {}): WorkflowState {
  return {
    original_request: 'epic 1',
    refined_request: 'Build the CI pipeline',
    subtasks,
    ...extra,
  };
}

describe('formatWorkflowStatus', () => {
  it('reports no workflow when there are no subtasks', () => {
    const out = formatWorkflowStatus(state([]));
    expect(out).toContain('No workflow state found');
  });

  it('shows request, feature branch, and progress counts', () => {
    const out = formatWorkflowStatus(state(
      [
        task({ id: 'WI-1', status: 'completed' }),
        task({ id: 'WI-2', status: 'in_progress', attempts: 2, phase: 'reviewing' }),
        task({ id: 'WI-3', status: 'pending' }),
        task({ id: 'WI-4', status: 'failed', attempts: 5 }),
      ],
      { featureBranch: 'feature/ep01-ci' },
    ));
    expect(out).toContain('Build the CI pipeline');
    expect(out).toContain('`feature/ep01-ci`');
    expect(out).toContain('1/4 done');
    expect(out).toContain('1 in progress');
    expect(out).toContain('1 pending');
    expect(out).toContain('1 failed');
  });

  it('shows phase and attempt for the in-progress task', () => {
    const out = formatWorkflowStatus(state([
      task({ id: 'WI-2', status: 'in_progress', attempts: 2, phase: 'reviewing' }),
    ]));
    expect(out).toContain('(attempt 2)');
    expect(out).toContain('reviewer working');
  });

  it('warns when a task is in_progress but no executor is live', () => {
    const out = formatWorkflowStatus(
      state([task({ id: 'WI-2', status: 'in_progress' })]),
      { executorActive: false, interruptPending: false },
    );
    expect(out).toContain('no executor is running');
  });

  it('reports a running engine when the executor is live', () => {
    const out = formatWorkflowStatus(
      state([task({ id: 'WI-2', status: 'in_progress' })]),
      { executorActive: true, interruptPending: false },
    );
    expect(out).toContain('running in this session');
  });

  it('reports a pending interrupt', () => {
    const out = formatWorkflowStatus(
      state([task({ id: 'WI-2', status: 'in_progress' })]),
      { executorActive: true, interruptPending: true },
    );
    expect(out).toContain('interrupt pending');
  });

  it('includes latest reviewer feedback for the current task, truncated', () => {
    const longFeedback = 'x'.repeat(700);
    const out = formatWorkflowStatus(state([
      task({ id: 'WI-2', status: 'in_progress', feedback: longFeedback }),
    ]));
    expect(out).toContain('Latest reviewer feedback (WI-2)');
    expect(out).toContain('x'.repeat(600) + '…');
    expect(out).not.toContain('x'.repeat(601));
  });

  it('falls back to failed-task feedback when nothing is in progress', () => {
    const out = formatWorkflowStatus(state([
      task({ id: 'WI-1', status: 'completed' }),
      task({ id: 'WI-4', status: 'failed', feedback: 'Tests missing for edge case' }),
    ]));
    expect(out).toContain('Latest reviewer feedback (WI-4)');
    expect(out).toContain('Tests missing for edge case');
  });

  it('truncates long task descriptions', () => {
    const out = formatWorkflowStatus(state([
      task({ id: 'WI-1', description: 'd'.repeat(120) }),
    ]));
    expect(out).toContain('d'.repeat(77) + '…');
    expect(out).not.toContain('d'.repeat(81));
  });
});

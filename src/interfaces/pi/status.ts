import type { WorkflowState, Subtask, TaskStatus } from '../../orchestrator/state.js';
import { versionString } from '../../version.js';

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  paused: '⏸️',
};

const PHASE_LABELS: Record<string, string> = {
  refining: 'refining subtasks',
  implementing: 'implementer working',
  quality_gates: 'running quality gates',
  reviewing: 'reviewer working',
  merging: 'merging',
};

function taskLine(task: Subtask): string {
  const icon = STATUS_ICONS[task.status] ?? '•';
  const attempts = task.attempts > 0 ? ` (attempt ${task.attempts})` : '';
  const phase = task.status === 'in_progress' && task.phase
    ? ` — ${PHASE_LABELS[task.phase] ?? task.phase}`
    : '';
  const desc = task.description.length > 80
    ? task.description.substring(0, 77) + '…'
    : task.description;
  return `${icon} **${task.id}**${attempts}${phase} — ${desc}`;
}

export interface StatusLiveInfo {
  /** True when a WorkflowExecutor exists in this session (workflow running or recently run). */
  executorActive: boolean;
  /** True when a pause/stop interrupt has been requested but not yet honored. */
  interruptPending: boolean;
}

/**
 * Render a read-only snapshot of the workflow state for /tdd:status.
 * Pure function over WorkflowState so it can be unit-tested without Pi.
 */
export function formatWorkflowStatus(state: WorkflowState, live?: StatusLiveInfo): string {
  if (state.subtasks.length === 0) {
    return 'No workflow state found in this project. Use `/tdd <epic>` to start one.';
  }

  const lines: string[] = ['## TDD Workflow Status', '', `_${versionString()}_`, ''];

  const request = state.refined_request || state.original_request;
  if (request) lines.push(`**Request:** ${request}`);
  if (state.featureBranch) lines.push(`**Feature branch:** \`${state.featureBranch}\``);

  const counts = {
    completed: state.subtasks.filter(t => t.status === 'completed').length,
    in_progress: state.subtasks.filter(t => t.status === 'in_progress').length,
    pending: state.subtasks.filter(t => t.status === 'pending').length,
    failed: state.subtasks.filter(t => t.status === 'failed').length,
    paused: state.subtasks.filter(t => t.status === 'paused').length,
  };
  const summaryParts = [
    `${counts.completed}/${state.subtasks.length} done`,
    counts.in_progress > 0 ? `${counts.in_progress} in progress` : '',
    counts.pending > 0 ? `${counts.pending} pending` : '',
    counts.failed > 0 ? `${counts.failed} failed` : '',
    counts.paused > 0 ? `${counts.paused} paused` : '',
  ].filter(Boolean);
  lines.push(`**Progress:** ${summaryParts.join(' · ')}`);

  if (live) {
    if (live.interruptPending) {
      lines.push('**Engine:** interrupt pending (pause/stop requested)');
    } else if (live.executorActive && counts.in_progress > 0) {
      lines.push('**Engine:** running in this session');
    } else if (!live.executorActive && counts.in_progress > 0) {
      lines.push('**Engine:** ⚠️ a task is marked in_progress but no executor is running in this session — it was likely interrupted. Use `/tdd <epic> resume` or `/tdd:resume`.');
    }
  }

  lines.push('', '### Tasks', '');
  for (const task of state.subtasks) {
    lines.push(taskLine(task));
  }

  const current = state.subtasks.find(t => t.status === 'in_progress');
  const blocked = state.subtasks.filter(t => t.status === 'failed' || t.status === 'paused');
  const detailTarget = current ?? blocked[0];
  if (detailTarget?.feedback) {
    const fb = detailTarget.feedback.length > 600
      ? detailTarget.feedback.substring(0, 600) + '…\n(full history in `.tdd-workflow/logs/`)'
      : detailTarget.feedback;
    lines.push('', `### Latest reviewer feedback (${detailTarget.id})`, '', fb);
  }

  return lines.join('\n');
}

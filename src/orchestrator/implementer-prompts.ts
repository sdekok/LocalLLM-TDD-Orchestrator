import type { Subtask } from './state.js';
import { extractActionItems, summarizeFeedbackHistory, type FeedbackRound } from './feedback.js';

/** Sent when the previous turn was aborted because of a thinking loop. */
export const ANTI_LOOP_NUDGE_PROMPT =
  'Your previous turn was aborted because you were stuck in a thinking loop, ' +
  'repeating the same sentences. **Do not think for this turn.** Immediately call ' +
  'a tool — `read` a specific file, `bash` to run tests, or `write`/`edit` to make a ' +
  'concrete change. Skip the reasoning step and act.';

/** Sent when the implementer went quiet without signalling DONE. */
export const CONTINUE_NUDGE_PROMPT =
  'You have not signalled DONE yet. Continue implementing — write the remaining files, run the tests, commit, then end your message with `DONE: <summary>`.';

/** Shared markdown sections for task metadata (acceptance, security, tests, notes). */
function taskMetadataSections(task: Subtask): string {
  let out = '';
  if (task.acceptance?.length) {
    out += `\n### Acceptance Criteria\n- ${task.acceptance.join('\n- ')}\n`;
  }
  if (task.security) {
    out += `\n### Security Requirements\n${task.security}\n`;
  }
  if (task.tests?.length) {
    out += `\n### Required Tests\n- ${task.tests.join('\n- ')}\n`;
  }
  if (task.devNotes) {
    out += `\n### Developer Notes\n${task.devNotes}\n`;
  }
  return out;
}

/** First turn of a fresh task: full description + metadata. */
export function buildInitialTaskPrompt(task: Subtask, technicalDescription: string): string {
  let prompt = technicalDescription;
  if (task.acceptance && task.acceptance.length > 0) {
    prompt += `\n\n### Acceptance Criteria\n- ${task.acceptance.join('\n- ')}`;
  }
  if (task.security) {
    prompt += `\n\n### Security Requirements\n${task.security}`;
  }
  if (task.tests && task.tests.length > 0) {
    prompt += `\n\n### Required Tests\n- ${task.tests.join('\n- ')}`;
  }
  if (task.devNotes) {
    prompt += `\n\n### Developer Implementation Notes\n${task.devNotes}`;
  }
  return prompt;
}

/**
 * Retry turn within the same session: the branch still has the previous
 * implementation, so send only a short checklist of this round's items. The
 * full feedback text lives in the on-disk history file — dumping every round's
 * full text here was a major context-bloat source (a test cascade → 100K+ tokens).
 */
export function buildRetryFeedbackPrompt(
  taskId: string,
  feedback: string,
  feedbackHistoryLength: number,
): string {
  const priorNote = feedbackHistoryLength > 1
    ? ` (${feedbackHistoryLength - 1} earlier round(s) are recorded there too)`
    : '';

  return (
    `Your previous code is still on this branch — do not start from scratch.\n\n` +
    `## Issues to Address This Round\n\n${extractActionItems(feedback)}\n\n` +
    `_Full detail for each item: \`.tdd-workflow/logs/feedback-history-${taskId}.md\`${priorNote}._\n\n` +
    `## How to apply this feedback\n\n` +
    `For each issue raised in the latest round:\n` +
    `1. Find the exact location in your code.\n` +
    `2. Understand *why* it is wrong, not just what to change.\n` +
    `3. Fix it — touch whatever files are needed to fully address the feedback.\n` +
    `4. Check whether the **same pattern** exists elsewhere in files you have already modified — if so, fix those instances too. This generalisation sweep is scoped to your existing diff; do not refactor unrelated code that the reviewer did not mention.\n\n` +
    `When done: run the tests, do a final \`git diff HEAD\` to confirm there are no regressions or unintended changes, then commit and signal \`DONE:\`.`
  );
}

export interface FixerPromptParams {
  task: Subtask;
  technicalDescription: string;
  attempt: number;
  branchName: string;
  originalBranch: string;
  feedback: string;
  feedbackHistory: FeedbackRound[];
  /** Current branch diff vs base, already truncated by the caller. Empty string when none. */
  inlineDiff: string;
}

/**
 * Session-reset first turn: self-contained fixer prompt. The full history is
 * written to disk by the caller; this includes an inline summary (bounded size)
 * and the current diff so the model has complete context without relying on
 * conversation history.
 */
export function buildFixerPrompt(params: FixerPromptParams): string {
  const { task, technicalDescription, attempt, branchName, originalBranch, feedback, feedbackHistory, inlineDiff } = params;
  const latestFeedback = feedbackHistory[feedbackHistory.length - 1]!;
  const latestLabel = latestFeedback.type === 'gates' ? 'Quality Gates' : 'Code Review';

  let prompt =
    `## Context Reset — Round ${attempt} Fixer\n\n` +
    `Session reset after ${feedbackHistory.length} round(s) to keep context manageable. ` +
    `All work is preserved on branch \`${branchName}\`.\n\n` +
    `### Task: ${task.id}\n${technicalDescription}\n`;

  prompt += taskMetadataSections(task);

  // Include the current diff inline so the model sees the existing
  // implementation immediately without needing a tool call.
  prompt += inlineDiff
    ? `\n### Current Implementation (git diff ${originalBranch})\n\`\`\`diff\n${inlineDiff}\n\`\`\`\n`
    : `\n### Current Implementation\nBranch \`${branchName}\` — no committed changes yet.\n`;

  // Send a short checklist of what to address — the full detail is in
  // the on-disk feedback history, so we don't flood the context window.
  prompt +=
    `\n### Issues to Address — Round ${latestFeedback.round} (${latestLabel})\n` +
    `${extractActionItems(feedback)}\n` +
    `\n_Full detail for each item: \`.tdd-workflow/logs/feedback-history-${task.id}.md\`._\n`;

  // Include a size-bounded summary of all prior rounds so the model
  // knows what has already been tried.
  if (feedbackHistory.length > 1) {
    const priorRounds = feedbackHistory.slice(0, -1);
    prompt +=
      `\n### Prior Round Summary (${priorRounds.length} round(s))\n` +
      summarizeFeedbackHistory(priorRounds) + '\n';
  }

  prompt +=
    `\n### Instructions\n` +
    `Fix the issues in the latest feedback above. Do not start from scratch — patch the existing implementation.\n` +
    `When done: run the tests, do a final \`git diff HEAD\` to confirm no regressions, commit, and signal \`DONE: <summary>\`.`;

  return prompt;
}

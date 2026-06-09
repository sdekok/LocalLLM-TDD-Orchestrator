import type { Subtask } from './state.js';
import { boundFeedbackForPrompt } from './feedback.js';

/** One record per implement→review cycle, used by the arbiter for loop detection. */
export interface IterationRecord {
  attempt: number;
  implementerSummary: string;
  reviewerFeedback: string;
}

export interface ArbiterDecision {
  decision: 'approve' | 'continue' | 'escalate';
  rounds: number;
  rationale: string;
  /** False when the structured DECISION:/RATIONALE: lines could not be parsed. */
  parsedOk: boolean;
}

export function buildArbiterPrompt(
  task: Subtask,
  diff: string,
  changedFiles: string[],
  feedback: string,
  qualityGatesPassed: boolean,
  iterationHistory: IterationRecord[],
): string {
  const diffSummary = changedFiles.length > 0
    ? `\n\n## Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n')}\n\n## Diff\n\`\`\`diff\n${diff.length > 6000 ? diff.substring(0, 6000) + '\n… (truncated)' : diff}\n\`\`\``
    : '\n\n## Diff\n(no diff captured)';

  const historySummary = iterationHistory.length > 0
    ? `\n\n## Iteration History (${iterationHistory.length} attempt(s))\n` +
      iterationHistory.map(r =>
        `### Attempt ${r.attempt}\n**Implementer claimed:** ${r.implementerSummary.substring(0, 300)}\n**Reviewer feedback:** ${r.reviewerFeedback.substring(0, 300)}`
      ).join('\n\n')
    : '';

  return (
    `## Task\n${task.description}\n\n` +
    `## Quality Gates\n${qualityGatesPassed ? '✅ Passed' : '❌ Failed — code has blocking quality issues'}\n\n` +
    `## Reviewer's Final Feedback\n${feedback ? boundFeedbackForPrompt(feedback) : '(no feedback recorded)'}` +
    historySummary +
    diffSummary
  );
}

/** Parse the arbiter's structured DECISION:/ROUNDS:/RATIONALE: response. */
export function parseArbiterDecision(arbiterText: string): ArbiterDecision {
  const decisionMatch = arbiterText.match(/DECISION:\s*(approve|continue|escalate)/i);
  const roundsMatch   = arbiterText.match(/ROUNDS:\s*(\d+)/i);
  const rationaleMatch = arbiterText.match(/RATIONALE:\s*(.+)/i);

  return {
    decision: (decisionMatch?.[1]?.toLowerCase() ?? 'escalate') as ArbiterDecision['decision'],
    rounds: parseInt(roundsMatch?.[1] ?? '1', 10),
    rationale: rationaleMatch?.[1]?.trim() ?? 'Arbiter provided no rationale.',
    parsedOk: !!(decisionMatch && rationaleMatch),
  };
}

export interface EscalationReply {
  action: 'approve' | 'continue' | 'stop';
  rounds: number;
}

/** Build the chat message asking the user to break an implementer/reviewer deadlock. */
export function buildEscalationMessage(
  task: Subtask,
  diff: string,
  feedback: string,
  arbiterRationale: string,
  maxAttempts: number,
): string {
  const diffPreview = diff.length > 1500 ? diff.substring(0, 1500) + '\n… (truncated)' : diff;
  const feedbackPreview = feedback.length > 400 ? feedback.substring(0, 400) + '…' : feedback;

  return (
    `⚖️ **Arbiter: your input needed for ${task.id}**\n\n` +
    `The task could not be resolved after ${maxAttempts} attempts.\n\n` +
    `**Arbiter's assessment:** ${arbiterRationale}\n\n` +
    `**Task:** ${task.description}\n\n` +
    `**Reviewer's final feedback:**\n${feedbackPreview}\n\n` +
    `**Diff preview:**\n\`\`\`diff\n${diffPreview}\n\`\`\`\n\n` +
    `**Your options (reply with one):**\n` +
    `- \`approve\` — accept the current implementation as-is\n` +
    `- \`continue N\` — grant N more rounds (e.g. \`continue 3\`)\n` +
    `- \`stop\` — mark as failed and move on`
  );
}

/** Parse the user's escalation reply: "approve" | "continue N" | anything else → stop. */
export function parseEscalationReply(answer: string | null): EscalationReply {
  if (!answer?.trim()) return { action: 'stop', rounds: 0 };
  const lower = answer.trim().toLowerCase();
  if (lower === 'approve') return { action: 'approve', rounds: 0 };
  const continueMatch = lower.match(/^continue\s+(\d+)$/);
  if (continueMatch) {
    return { action: 'continue', rounds: parseInt(continueMatch[1]!, 10) };
  }
  return { action: 'stop', rounds: 0 };
}

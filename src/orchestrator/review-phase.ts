import { getLogger } from '../utils/logger.js';
import { reviewerVerdictComplete } from './feedback.js';
import { withTimeout } from './timeout.js';

/**
 * Follow-up sent when a reviewer analysed but didn't produce the required
 * structured verdict (missing APPROVED:, or a rejection with no usable FEEDBACK:).
 */
export const REVIEWER_FORMAT_REMINDER =
  'STOP all tool calls. Do NOT read any more files.\n\n' +
  'Your review is complete but the structured verdict is missing or malformed. ' +
  'Output ONLY these three lines right now, with these EXACT labels — nothing else:\n\n' +
  'APPROVED: true/false\n' +
  'SCORES: test_coverage=X integration=X error_handling=X security=X (1-5)\n' +
  'FEEDBACK: <if APPROVED is false, the concrete changes needed — based on what you already read>';

/** Generous retry timeout — thinking models need several minutes even for short replies. */
export const FORMAT_RETRY_TIMEOUT_MS = 10 * 60 * 1000;

export interface ReviewerVerdict {
  approved: boolean;
  /** The FEEDBACK: section, or a fallback explanation when the format wasn't followed. */
  feedback: string;
}

/**
 * Parse the reviewer's structured verdict. Only the FEEDBACK: section is used
 * as feedback — not the full review analysis. If the reviewer didn't follow the
 * format, the verdict is a rejection with a clear message rather than confusing
 * analysis text being dumped into the implementer's prompt.
 */
export function parseReviewerVerdict(reviewText: string): ReviewerVerdict {
  const approved = /APPROVED:\s*true/i.test(reviewText);
  const feedbackMatch = reviewText.match(/FEEDBACK:\s*([\s\S]*)$/i);
  const feedback = (feedbackMatch?.[1]?.trim())
    || (reviewText.trim()
      ? `Reviewer rejected but did not follow the structured output format. Full review:\n${reviewText.substring(0, 600)}`
      : 'Reviewer session produced no output — possible timeout or crash.');
  return { approved, feedback };
}

/** Minimal slice of the session/stream-handle pair the format retry needs. */
export interface ReviewerSessionHandle {
  prompt(text: string): Promise<unknown>;
  getTurnText(): string;
  resetTurnText(): void;
}

/**
 * If the captured review text lacks a complete structured verdict, send one
 * format-reminder follow-up and return whichever text ends up complete.
 * Falls back to the original text when the retry fails or is still malformed.
 *
 * @param isComplete verdict predicate — defaults to reviewerVerdictComplete;
 *   the final workflow review uses a looser APPROVED:-only check.
 */
export async function ensureStructuredVerdict(
  session: ReviewerSessionHandle,
  reviewText: string,
  label: string,
  isComplete: (text: string) => boolean = reviewerVerdictComplete,
): Promise<string> {
  if (isComplete(reviewText)) return reviewText;

  getLogger().warn(`[${label}] Reviewer verdict incomplete (missing APPROVED: or FEEDBACK:) — sending format reminder`);
  const saved = reviewText;
  session.resetTurnText();
  try {
    await withTimeout(
      session.prompt(REVIEWER_FORMAT_REMINDER),
      FORMAT_RETRY_TIMEOUT_MS,
      'format-retry-timeout',
    );
    reviewText = session.getTurnText();
  } catch {
    return saved; // retry failed — restore original
  }
  return isComplete(reviewText) ? reviewText : saved;
}

export interface TaskReviewPromptParams {
  taskDescription: string;
  implementerNotes: string;
  commitLog: string;
  originalBranch: string;
  changedFiles: string[];
  diff: string;
  /** Lens output before/after the task; empty strings omit the section. */
  lensBaseline: string;
  lensAfter: string | null;
}

/**
 * Build the per-task reviewer prompt: notes first (context), then commit log,
 * then lens before/after, then the diff (evidence). The commit log lets the
 * reviewer see the per-commit story of the WI branch — useful when there are
 * several iterations and the cumulative diff is large.
 */
export function buildTaskReviewPrompt(params: TaskReviewPromptParams): string {
  const { taskDescription, implementerNotes, commitLog, originalBranch, changedFiles, diff, lensBaseline, lensAfter } = params;

  const notesSummary = implementerNotes
    ? `\n\n## Implementer Notes\n${implementerNotes}`
    : '';
  const commitLogSummary = commitLog
    ? `\n\n## Commits on this branch (vs ${originalBranch})\n${commitLog}`
    : '';
  const diffSummary = changedFiles.length > 0 || diff.trim().length > 0
    ? `\n\n## Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n')}\n\n## Diff (full branch diff vs ${originalBranch})\n\`\`\`diff\n${diff.length > 8000 ? diff.substring(0, 8000) + '\n… (truncated)' : diff}\n\`\`\``
    : '\n\n## Diff\n_(no diff captured — check workflow log for git failures)_';

  // The reviewer uses lens before/after to judge whether new structural/type
  // issues were introduced by this task specifically.
  let lensSection = '';
  if (lensAfter !== null) {
    const beforeText = lensBaseline || 'No issues';
    const afterText = lensAfter || 'No issues';
    lensSection = `\n\n## Lens Analysis (Structural & Type Checks)\n**Before this task:**\n${beforeText}\n\n**After this task:**\n${afterText}`;
  }

  return `Review the implementation for task: ${taskDescription}${notesSummary}${commitLogSummary}${lensSection}${diffSummary}`;
}

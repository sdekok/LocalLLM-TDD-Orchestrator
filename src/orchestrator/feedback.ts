import * as fs from 'fs';
import * as path from 'path';

/** One round of feedback shown to the implementer on retries. */
export interface FeedbackRound {
  round: number;
  type: 'gates' | 'review';
  text: string;
}

/**
 * Detect if two strings are suspiciously similar (agent is looping).
 * Uses a simple character-level comparison — fast and good enough for code output.
 */
export function outputSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;

  if (longer.length === 0) return 1;

  // Quick check: if lengths differ by >30%, they're probably different
  if (shorter.length / longer.length < 0.7) return shorter.length / longer.length;

  // Count matching characters in order (simple LCS approximation)
  let matches = 0;
  let j = 0;
  for (let i = 0; i < shorter.length && j < longer.length; i++) {
    if (shorter[i] === longer[j]) {
      matches++;
      j++;
    } else {
      // Try to find the character nearby
      const lookAhead = longer.indexOf(shorter[i]!, j);
      if (lookAhead !== -1 && lookAhead - j < 5) {
        matches++;
        j = lookAhead + 1;
      }
    }
  }

  return matches / longer.length;
}

/**
 * Cap feedback/gate text before it's injected into a model prompt. A failing
 * gate can dump the full test/build output (a single broken import can cascade
 * into thousands of failing-test signatures), and that text is interpolated raw
 * into both the implementer's fixer prompt and the arbiter prompt. Left
 * unbounded it blows past the model's context window → the model returns empty
 * output (no DONE / no verdict). The full text is always preserved on disk in
 * .tdd-workflow (feedback history + gate reports), so truncating the prompt copy
 * loses nothing actionable — the first N chars carry the actionable head.
 */
export function boundFeedbackForPrompt(text: string, maxChars = 6000): string {
  if (!text || text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n… (${omitted.toLocaleString()} more chars truncated to protect the context window — full details in .tdd-workflow/logs)`;
}

/**
 * Reduce verbose reviewer/gate feedback to a short, actionable checklist for the
 * fixer/retry prompt. The full text is written to the on-disk feedback history
 * (.tdd-workflow/logs/feedback-history-<taskId>.md), so the model only needs the
 * LIST of what to address — not paragraphs of detail that bloat the context.
 * Parses numbered items (`1.`/`1)`) and bullets (`-`,`*`,`•`), keeping each
 * item's title line. Falls back to a small bounded snippet when there's no list.
 */
export function extractActionItems(feedback: string, maxItems = 15, maxLen = 200): string {
  if (!feedback) return '';
  const clean = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  const numbered: string[] = [];
  const bullets: string[] = [];
  let skipping = false;
  for (const raw of feedback.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Once we reach a "Non-issues / already known / pre-existing / nits" section,
    // stop collecting — those are explicitly NOT things to fix. (The bug this
    // guards against: a reviewer's trailing non-issues bullet list getting sent
    // as the checklist while the real bold-numbered blockers were dropped.)
    const bare = line.replace(/^[*_#>\s]+/, '');
    if (/^(non[-\s]?issues?|already[-\s]known|pre[-\s]?existing|nit(s|picks)?|out[-\s]of[-\s]scope)\b/i.test(bare)) {
      skipping = true;
    }
    if (skipping) continue;
    // Numbered item — tolerate markdown wrappers like **1. …**, ### 1) …, > 1. …
    const num = line.match(/^[*_#>\s]*\d+[.)]\s+(.+\S)/);
    if (num) { numbered.push(clean(num[1]!)); continue; }
    // Bullet item (dash or • — not "*", which collides with **bold** emphasis).
    const bul = line.match(/^[>\s]*[-•]\s+(.+\S)/);
    if (bul) bullets.push(clean(bul[1]!));
  }
  // Prefer numbered items (the reviewer's main issues); bullets are usually
  // sub-points. Fall back to a bounded snippet only if nothing parsed.
  const chosen = (numbered.length ? numbered : bullets).slice(0, maxItems);
  if (chosen.length === 0) return boundFeedbackForPrompt(feedback, 1500);
  return chosen.map((t, i) => `${i + 1}. ${t.length > maxLen ? t.slice(0, maxLen) + '…' : t}`).join('\n');
}

/**
 * A reviewer verdict is "complete" only when it states `APPROVED: true|false`
 * AND — for a rejection — includes a non-empty `FEEDBACK:` section. A rejection
 * with no usable FEEDBACK (missing, empty, or a typo'd header like `FEEDFIX:`)
 * leaves the implementer nothing actionable, so we re-prompt the reviewer to
 * emit the structured format instead of dumping its raw analysis/thinking.
 * An approval needs no feedback.
 */
export function reviewerVerdictComplete(text: string): boolean {
  if (!/APPROVED:\s*(true|false)/i.test(text)) return false;
  if (/APPROVED:\s*false/i.test(text)) {
    const m = text.match(/FEEDBACK:\s*([\s\S]*?)\s*$/i);
    return !!(m && m[1] && m[1].trim().length > 0);
  }
  return true;
}

/**
 * Write (or overwrite) a per-task feedback history file with full round details.
 * Used as a reference; the inline fixer prompt uses summarizeFeedbackHistory instead.
 */
export function writeFeedbackHistory(
  taskId: string,
  feedbackHistory: FeedbackRound[],
  projectDir: string,
): string {
  const logsDir = path.join(projectDir, '.tdd-workflow', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, `feedback-history-${taskId}.md`);

  const lines: string[] = [`# Feedback History — ${taskId}\n`];
  for (const h of feedbackHistory) {
    const label = h.type === 'gates' ? 'Quality Gates' : 'Code Review';
    lines.push(`## Round ${h.round} — ${label}\n\n${h.text}\n`);
  }
  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

/**
 * Produce a compact inline summary of all prior feedback rounds for inclusion
 * in the session-reset fixer prompt.
 *
 * - For review rounds: extracts only the FEEDBACK: section from the structured
 *   reviewer output, truncated to maxCharsPerRound.
 * - For gate rounds: takes the text as-is (already compact), truncated.
 *
 * This keeps the "history" contribution to the context window bounded no matter
 * how many rounds have elapsed.
 */
export function summarizeFeedbackHistory(
  feedbackHistory: FeedbackRound[],
  maxCharsPerRound = 400,
): string {
  return feedbackHistory
    .map(h => {
      const label = h.type === 'gates' ? 'Quality Gates' : 'Code Review';
      let summary: string;
      if (h.type === 'review') {
        const match = h.text.match(/FEEDBACK:\s*([\s\S]*?)$/im);
        summary = match ? match[1]!.trim() : h.text;
      } else {
        summary = h.text;
      }
      if (summary.length > maxCharsPerRound) {
        summary = summary.slice(0, maxCharsPerRound) + '…';
      }
      return `**Round ${h.round} (${label})**: ${summary}`;
    })
    .join('\n\n');
}

/**
 * Detect "I have no questions" placeholder content the implementer sometimes
 * writes to `.tdd-workflow/questions.md` despite the prompt telling it not to.
 * Returns true when the file should be treated as if it were empty.
 *
 * Examples that should be filtered:
 *   "(No questions — all acceptance criteria met.)"
 *   "No questions."
 *   "N/A"
 *   "None"
 *   bullet lists with no real questions ("- (none)" / "1. n/a")
 */
export function isNoQuestionsPlaceholder(text: string): boolean {
  // Strip markdown bullets, numbering, surrounding punctuation/whitespace.
  const stripped = text
    .replace(/^[\s\-*•#>]+/gm, '')  // leading bullets/markers per line
    .replace(/^\d+[.)]\s*/gm, '')   // ordered list markers
    .replace(/[()[\]*_`]/g, '')     // surrounding punctuation
    .trim();
  if (!stripped) return true;
  // Collapse whitespace and strip trailing punctuation for matching.
  const normalised = stripped.replace(/\s+/g, ' ').replace(/[.!?…—-]+$/g, '').toLowerCase();
  const sentinels = [
    /^no questions?\b/,
    /^no remaining questions?\b/,
    /^none\b/,
    /^n\/?a\b/,
    /^nothing( to ask)?\b/,
    /^all (acceptance )?criteria (met|satisfied)\b/,
    /^no blockers\b/,
    /^no ambiguities\b/,
  ];
  return sentinels.some(re => re.test(normalised));
}

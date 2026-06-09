import { EventEmitter } from 'events';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { StateManager, WorkflowState, Subtask } from './state.js';
import * as path from 'path';
import { Sandbox } from './sandbox.js';
import { runQualityGates, runLensAnalysis, collectCoverageSnapshot, type CoverageMetrics } from './quality-gates.js';
import { ModelRouter } from '../llm/model-router.js';
import { SearchClient } from '../search/searxng.js';
import { planAndBreakdown } from '../agents/planner.js';
import { EpicLoader, EpicPlan } from './epic-loader.js';
import { createSubAgentSession, type SubAgentOptions } from '../subagent/factory.js';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { IMPLEMENTER_PROMPT, REVIEWER_PROMPT, ARBITER_PROMPT } from '../subagent/prompts.js';
import { getLogger } from '../utils/logger.js';
import { execFileAsync, DEFAULT_MAX_BUFFER, sanitizeBranchName } from '../utils/exec.js';
import { getTestCommand, getCoverageTestCommand, detectPackageManager } from './test-runner.js';
import {
  outputSimilarity,
  boundFeedbackForPrompt,
  writeFeedbackHistory,
  isNoQuestionsPlaceholder,
  type FeedbackRound,
} from './feedback.js';
import { LessonStore, LESSON_EXTRACTOR_PROMPT, parseLessonCandidates, type LessonCandidate } from './lessons.js';
import { withTimeout } from './timeout.js';
import {
  buildInitialTaskPrompt,
  buildRetryFeedbackPrompt,
  buildFixerPrompt,
  ANTI_LOOP_NUDGE_PROMPT,
  CONTINUE_NUDGE_PROMPT,
} from './implementer-prompts.js';
import { parseReviewerVerdict, ensureStructuredVerdict, buildTaskReviewPrompt, type ReviewerSessionHandle } from './review-phase.js';
import {
  buildArbiterPrompt,
  parseArbiterDecision,
  buildEscalationMessage,
  parseEscalationReply,
  type IterationRecord,
} from './arbiter-phase.js';
import { evaluateGateFailures } from './gate-evaluation.js';
import { UsageTracker } from './usage-tracker.js';

// Re-exported for backwards compatibility — tests and external callers import these from here.
export {
  outputSimilarity,
  boundFeedbackForPrompt,
  extractActionItems,
  reviewerVerdictComplete,
  isNoQuestionsPlaceholder,
} from './feedback.js';
export { withTimeout } from './timeout.js';

/**
 * Derive a short, stable, git-safe slug from an original workflow request.
 *
 * - Numeric/epic-ref requests ("1", "01", "epic-3") → "ep01", "ep03" etc.
 * - All other requests → 6-char hex hash of the request string.
 *
 * The slug is used as a namespace within the tdd-workflow/* branch hierarchy
 * so branches from different epics/workflows never collide.
 */
function workflowSlug(originalRequest: string): string {
  const trimmed = originalRequest.trim();
  const epicRefMatch = trimmed.match(/^(?:epic[-\s]*)?(\d{1,3})$/i);
  if (epicRefMatch) {
    return `ep${epicRefMatch[1]!.padStart(2, '0')}`;
  }
  return createHash('sha1').update(trimmed).digest('hex').substring(0, 6);
}

/**
 * Derive a feature branch name from a workflow's slug and refined title.
 * e.g. "ep01" + "Design Tokens & Theme System" → "feature/ep01-design-tokens-theme-system"
 */
function buildFeatureBranchName(originalRequest: string, refinedRequest: string): string {
  const slug = workflowSlug(originalRequest);
  const titleSlug = (refinedRequest || originalRequest)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  return `feature/${slug}-${titleSlug}`.replace(/-+/g, '-').replace(/-$/, '');
}

export interface ExecutorOptions {
  searchClient?: SearchClient | null;
  /**
   * Optional callback to post messages into the Pi chat history.
   * `type` is a custom message type (e.g. 'tdd-orchestrator', 'tdd-implementer') that
   * the UI can use to render different agent sources with distinct headings.
   */
  chatMessage?: (content: string, type?: string) => void;
  /**
   * Optional callback to ask the user a question and await their reply.
   * Used when an agent writes questions to .tdd-workflow/questions.md.
   * The timeout races only cover agent sessions — user interaction time
   * is outside the race so it never counts against the agent budget.
   * Returns null if the user cancels or no handler is wired.
   */
  waitForInput?: (prompt: string) => Promise<string | null>;
}

const MAX_ATTEMPTS = 5;
const MAX_IMPLEMENTER_DURATION_MS = 60 * 60 * 1000;  // 60 minutes for the implementer
const MAX_REVIEWER_DURATION_MS    = 60 * 60 * 1000;  // 60 minutes for the reviewer
const MAX_ARBITER_DURATION_MS     = 20 * 60 * 1000;  // 20 minutes for the arbiter
/** Silence threshold for mid-turn steer nudges — 5 minutes with no activity. */
const IDLE_NUDGE_MS               =  5 * 60 * 1000;
/**
 * Refresh the implementer session every N reviewer-rejection rounds to prevent
 * the context window from growing unbounded. The fresh session gets the original
 * ticket, the latest feedback, and a path to a history file with prior rounds.
 */
const SESSION_REFRESH_AFTER = 2;
const MAX_CONSECUTIVE_FAILURES = 3;            // Circuit breaker for the whole workflow
const LESSON_EXTRACTION_TIMEOUT_MS = 5 * 60 * 1000; // Budget for the post-task lesson-extraction call
const MAX_ARBITER_ROUNDS = 3;                  // Max arbiter consultations per task — each can grant another "continue N"

/**
 * Thrown when the implementer model produces no response at all (no provider
 * output) — i.e. the endpoint is unreachable or the configured model id doesn't
 * resolve to a live model. This is a connectivity/config problem, NOT a task
 * failure, so the workflow halts cleanly without marking the task failed or
 * nudging into the void.
 */
export class ModelUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnreachableError';
  }
}
const SIMILARITY_THRESHOLD = 0.9;              // If outputs are >90% similar, it's a loop
/** Delay after sub-agent session disposal to allow slot reclaim. Override with TDD_SLOT_RECOVERY_MS env var. */
const SLOT_RECOVERY_DELAY_MS = parseInt(process.env['TDD_SLOT_RECOVERY_MS'] ?? '5000', 10);


export interface SessionRefreshParams {
  attempt: number;
  /** Number of feedback rounds accumulated so far (0 = nothing to fix yet). */
  feedbackRounds: number;
  /** Most recent observed prompt size in tokens (usage.input + cacheRead); 0 = provider reports no usage. */
  lastPromptTokens: number;
  /** Token threshold above which the session should be refreshed. */
  refreshTokenThreshold: number;
  /** Round-based fallback cadence, used only when the provider reports no usage. */
  refreshAfterRounds: number;
}

/**
 * Decide whether to replace the long-running implementer session with a fresh
 * one. Token-denominated when real usage data is available: a session is
 * refreshed when its actual prompt size crosses the threshold — one heavy
 * thinking round can cross it while several light rounds may never need a
 * reset. Falls back to the legacy round cadence only when the provider does
 * not report token usage.
 */
export function shouldRefreshSession(p: SessionRefreshParams): { refresh: boolean; reason: 'tokens' | 'rounds' | null } {
  if (p.attempt <= 1 || p.feedbackRounds === 0) return { refresh: false, reason: null };
  if (p.lastPromptTokens > 0) {
    return p.lastPromptTokens >= p.refreshTokenThreshold
      ? { refresh: true, reason: 'tokens' }
      : { refresh: false, reason: null };
  }
  return (p.attempt - 1) % p.refreshAfterRounds === 0
    ? { refresh: true, reason: 'rounds' }
    : { refresh: false, reason: null };
}

export class WorkflowExecutor {
  private state: StateManager;
  private modelRouter: ModelRouter;
  private sandbox: Sandbox;
  private searchClient: SearchClient | null;
  private chatMessage: ((content: string, type?: string) => void) | null;
  private waitForInput: ((prompt: string) => Promise<string | null>) | null;
  /** Set by resume() so processQueue knows to keep existing task branches. */
  private resumeMode = false;
  /** When set, processQueue only runs the task with this ID. */
  private singleTaskId: string | null = null;
  /**
   * User-initiated interrupt flags. `requestPause()` / `requestStop()` set
   * these; poll points inside processQueue check them and exit gracefully.
   *
   *  - pauseRequested: finish the current agent prompt, then mark the current
   *    task `paused` (attempts + feedback preserved) and exit. Resumable via
   *    `/tdd N resume` (or `/tdd:resume`).
   *  - stopRequested: immediately dispose the active session to abort the
   *    in-flight prompt, roll back the task branch to base, reset the task
   *    to `pending` with attempts=0, and exit. The repo looks like the task
   *    never ran.
   *
   * stop trumps pause: if both are set, we take the stop path.
   */
  private pauseRequested = false;
  private stopRequested = false;
  /**
   * Set when a subagent model produced no response (ModelUnreachableError).
   * Carries the human-readable reason for the connectivity-halt chat message.
   */
  private modelUnreachableReason: string | null = null;

  /**
   * UI notifier passed to subagent sessions so model-resolution warnings
   * (e.g. fallback to Pi's default model) reach the user's chat, not just logs.
   */
  private notifyUi = (message: string, _level?: 'info' | 'warning' | 'error'): void => {
    this.chatMessage?.(message, 'tdd-orchestrator');
  };
  /**
   * The currently-running implementer session (if any), exposed so that
   * stop/pause can dispose it from outside the task loop. Assigned/cleared
   * at session lifetime boundaries inside processQueue.
   */
  private activeImplementerSession: AgentSession | null = null;
  private activeImplementerHandle: { getLastEventTime(): number; hasThinkingLoop(): boolean; clearThinkingLoop(): void; dispose(): void } | null = null;
  /**
   * Active usage trackers — every assistant message's token usage is recorded
   * into all of them. processQueue keeps one workflow-level tracker plus one
   * per-task tracker; outside a workflow (standalone review) the list is empty
   * and recording is a no-op.
   */
  private usageTrackers: UsageTracker[] = [];
  public events = new EventEmitter();

  constructor(
    state: StateManager,
    modelRouter: ModelRouter,
    options?: ExecutorOptions
  ) {
    this.state = state;
    this.modelRouter = modelRouter;
    this.sandbox = new Sandbox(state.projectDir);
    this.searchClient = options?.searchClient || null;
    this.chatMessage = options?.chatMessage || null;
    this.waitForInput = options?.waitForInput || null;
  }

  /**
   * Graceful interrupt: finish the current agent prompt, then mark the running
   * task `paused` and exit the workflow. Resumable via `/tdd N resume` (or
   * `/tdd:resume`). Idempotent — calling multiple times has no additional
   * effect until the executor picks it up at the next poll point.
   */
  requestPause(): void {
    if (this.pauseRequested || this.stopRequested) return;
    this.pauseRequested = true;
    getLogger().info('[EXECUTOR] Pause requested — will stop at next phase boundary');
    this.chatMessage?.('⏸ Pause requested — finishing the current agent turn, then stopping.', 'tdd-orchestrator');
  }

  /**
   * Immediate interrupt: dispose the active implementer session to abort its
   * in-flight prompt, roll back the task branch, reset the task to `pending`
   * with attempts=0 + feedback cleared, then exit the workflow. The repo ends
   * up looking like the current task never ran.
   */
  requestStop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    getLogger().info('[EXECUTOR] Stop requested — aborting active session and rolling back');
    this.chatMessage?.('🛑 Stop requested — aborting active agent and rolling back the current task.', 'tdd-orchestrator');
    // Force-dispose the live session so the in-flight prompt rejects quickly
    // rather than waiting up to MAX_IMPLEMENTER_DURATION_MS for the timeout.
    if (this.activeImplementerSession) {
      try { this.activeImplementerHandle?.dispose(); } catch { /* best-effort */ }
      try { this.activeImplementerSession.dispose(); } catch { /* best-effort */ }
      // Don't null here — the catch block in processQueue does the cleanup
      // accounting so the registry + post-error state line up.
    }
  }

  /** Returns true if an interrupt is pending. */
  isInterrupted(): boolean {
    return this.pauseRequested || this.stopRequested;
  }

  /**
   * Send an immediate steer-nudge to the active implementer session.
   * Safe to call at any time — no-ops if no session is active.
   */
  nudge(): void {
    if (!this.activeImplementerSession) {
      this.chatMessage?.('No active implementer session to nudge.', 'tdd-orchestrator');
      return;
    }
    getLogger().info('[EXECUTOR] Manual nudge requested');
    this.chatMessage?.('⏩ Manual nudge sent to implementer.', 'tdd-orchestrator');
    (this.activeImplementerSession as AgentSession).prompt(
      'Continue your work. You have not signalled DONE yet — write the remaining files, run the tests, commit, then end your message with `DONE: <summary>`.',
      { streamingBehavior: 'steer' },
    ).catch(() => {});
  }

  /**
   * Subscribe to a sub-agent session ONCE and return a handle that:
   *  - streams thinking / text / tool calls to Pi chat (`chatMessage`)
   *  - accumulates the agent's visible `text_end` output so callers can
   *    inspect the last turn's reply (e.g. for `DONE:` / `APPROVED:` checks)
   *  - exposes `resetTurnText()` so the caller can clear the accumulator
   *    between `prompt()` calls on the same session
   *  - exposes `dispose()` to stop processing further events without
   *    relying on the SDK exposing an explicit unsubscribe handle
   *
   * IMPORTANT: call this once per session. Previously the codebase subscribed
   * twice — once here, once inline for text capture — which duplicated
   * chat output on every retry and made the text accumulator race.
   */
  /**
   * The Pi SDK's `session.prompt()` resolves when the prompt is accepted, NOT
   * when the agent has finished streaming its response. If we let the
   * orchestrator advance to the next phase as soon as prompt() returns, the
   * previous agent can keep generating in parallel — interleaving output,
   * producing stale `getTurnText()` reads (e.g. "Reviewer missing structured
   * verdict" because we grabbed text before APPROVED: was emitted), and
   * making the workflow's state machine race with the model.
   *
   * Wait for the agent's `waitForIdle()` so the next phase only starts when
   * the current one is genuinely done.
   */
  private async promptUntilIdle(session: any, text: string, options?: any): Promise<void> {
    await session.prompt(text, options);
    const agent = (session as any)?.agent;
    if (agent?.waitForIdle) {
      try {
        await agent.waitForIdle();
      } catch (err) {
        getLogger().warn(`promptUntilIdle: waitForIdle threw — ${err}`);
      }
    }
  }

  private subscribeToSession(
    session: any,
    label: string,
    messageType: string,
  ): { getTurnText(): string; resetTurnText(): void; getLastEventTime(): number; getLastPromptTokens(): number; hasThinkingLoop(): boolean; clearThinkingLoop(): void; sawModelActivity(): boolean; dispose(): void } {
    const chatMessage = this.chatMessage;
    const logger = getLogger();
    const CHUNK_SIZE = 800;
    let thinkingBuffer = '';
    let turnText = '';
    let disposed = false;
    let lastEventTime = Date.now();
    // Actual prompt token count of the most recent provider request, from the
    // assistant message's usage block. 0 until the provider reports usage.
    let lastPromptTokens = 0;
    // True once the model has produced ANY output this turn (thinking, text, or a
    // tool call). Reset per turn via resetTurnText(). Used to distinguish "model
    // is working but not DONE" from "model never responded" (unreachable endpoint
    // / unresolved model) so the latter fails fast instead of nudging.
    let modelActivitySeen = false;

    // Per-turn thinking-loop detection. The cross-attempt similarity detector
    // catches loops between attempts; this catches loops WITHIN a single thinking
    // block where the model emits thousands of repeating chars and never
    // produces text_end or a tool call.
    const LOOP_MIN_THINKING_CHARS = 8000;      // don't start checking until enough thinking accumulated
    const LOOP_WINDOW_CHARS       = 3000;      // size of rolling buffer to inspect
    const LOOP_SAMPLE_LEN         = 100;       // substring sample size
    const LOOP_MIN_REPEATS        = 3;         // sample must appear this many times
    const MAX_DIRECT_ABORTS       = 3;         // cap on session.abort() calls from this subscriber
    let totalThinkingThisTurn = 0;
    let recentThinking = '';
    let thinkingLoopDetected = false;
    let directAbortCount = 0;

    const resetTurnProgress = () => {
      totalThinkingThisTurn = 0;
      recentThinking = '';
      thinkingLoopDetected = false;
    };

    const checkThinkingLoop = () => {
      if (thinkingLoopDetected) return;
      if (totalThinkingThisTurn < LOOP_MIN_THINKING_CHARS) return;
      // Sample from the middle of the rolling window — the start may include
      // legitimate setup thinking that doesn't repeat.
      const mid = Math.floor(recentThinking.length / 2);
      const sample = recentThinking.substring(mid, mid + LOOP_SAMPLE_LEN);
      if (sample.length < LOOP_SAMPLE_LEN) return;
      let count = 0;
      let idx = 0;
      while ((idx = recentThinking.indexOf(sample, idx)) !== -1) {
        count++;
        idx += sample.length;
        if (count >= LOOP_MIN_REPEATS) break;
      }
      if (count >= LOOP_MIN_REPEATS) {
        thinkingLoopDetected = true;
        logger.warn(`[${label}] Thinking loop detected: same ${LOOP_SAMPLE_LEN}-char window appears ${count}× in last ${recentThinking.length} chars (turn total: ${totalThinkingThisTurn} chars)`);

        // Take action immediately from inside the subscriber. The orchestrator's
        // watchdog timer may not be active (e.g. between attempts after a
        // cross-attempt similarity bail, or during user input from the arbiter
        // escalation prompt). Calling session.abort() here guarantees the loop
        // terminates regardless of the outer control flow.
        if (directAbortCount < MAX_DIRECT_ABORTS) {
          directAbortCount++;
          logger.warn(`[${label}] Calling session.abort() from detector (${directAbortCount}/${MAX_DIRECT_ABORTS})`);
          try {
            // Fire-and-forget — abort() returns a promise but we don't need to
            // await it inside an event callback. The awaiting prompt() will
            // resolve when the agent finishes aborting.
            (session as any).abort?.().catch((err: unknown) => {
              logger.warn(`[${label}] session.abort() rejected: ${err}`);
            });
          } catch (err) {
            logger.warn(`[${label}] session.abort() threw synchronously: ${err}`);
          }
        } else {
          logger.error(`[${label}] Loop persists after ${MAX_DIRECT_ABORTS} direct aborts — letting outer logic handle`);
        }
      }
    };

    /** Terminal signals that are worth surfacing in Pi chat. */
    const isTerminalSignal = (text: string) => /DONE:|APPROVED:|DECISION:/i.test(text);

    // Role for usage accounting, derived from the chat message type
    // ('tdd-implementer' → 'implementer'). Falls back to a generic label.
    const usageRole = (messageType || 'agent').replace(/^tdd-/, '');

    session.subscribe((event: any) => {
      if (disposed) return;
      lastEventTime = Date.now();

      // Token accounting: every assistant message carries a usage block.
      // Recorded independently of the text/tool handling below.
      if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.usage) {
        const usage = event.message.usage;
        for (const tracker of this.usageTrackers) tracker.record(usageRole, usage);
        // Actual prompt size of the latest request — input plus any cache-read
        // tokens (both count toward the model's context occupancy). Drives the
        // token-denominated session-refresh decision.
        lastPromptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0);
      }

      if (event.type === 'message_update') {
        modelActivitySeen = true;
        const ae = event.assistantMessageEvent;
        if (ae?.type === 'thinking_start') {
          thinkingBuffer = '';
          resetTurnProgress();
          logger.stream(label, '💭 Thinking…');
        } else if (ae?.type === 'thinking_delta' && ae.delta) {
          thinkingBuffer += ae.delta;
          totalThinkingThisTurn += ae.delta.length;
          recentThinking = (recentThinking + ae.delta).slice(-LOOP_WINDOW_CHARS);
          checkThinkingLoop();
          while (thinkingBuffer.length >= CHUNK_SIZE) {
            logger.stream(label, `💭 ${thinkingBuffer.substring(0, CHUNK_SIZE)}`);
            thinkingBuffer = thinkingBuffer.substring(CHUNK_SIZE);
          }
        } else if (ae?.type === 'thinking_end') {
          if (thinkingBuffer.trim()) {
            logger.stream(label, `💭 ${thinkingBuffer}`);
            thinkingBuffer = '';
          }
        } else if (ae?.type === 'text_end' && ae.content?.trim()) {
          // text_end is a sign of progress — clear loop state.
          resetTurnProgress();
          // Accumulate for the caller (e.g. DONE:/APPROVED: detection).
          turnText += ae.content;
          logger.stream(label, ae.content);
          // Only surface terminal signals in Pi chat — everything else stays in live.log.
          if (chatMessage && isTerminalSignal(ae.content)) {
            chatMessage(`**[${label}]** ${ae.content}`, messageType);
          }
        }
      } else if (event.type === 'message_end'
                 && event.message?.role === 'assistant'
                 && !turnText) {
        modelActivitySeen = true;
        // Fallback for non-streaming / non-reasoning sessions that never
        // emit text_end but do publish the final content array.
        const text = event.message.content?.find((c: any) => c.type === 'text')?.text;
        if (text) {
          turnText += text;
          logger.stream(label, text);
          if (chatMessage && isTerminalSignal(text)) {
            chatMessage(`**[${label}]** ${text}`, messageType);
          }
        }
        resetTurnProgress();
      } else if (event.type === 'tool_execution_start') {
        modelActivitySeen = true;
        // Tool calls are progress — clear loop state.
        resetTurnProgress();
        const toolName: string = event.toolName;
        const args = (event.args && typeof event.args === 'object') ? event.args as Record<string, unknown> : {};
        let msg = `🔧 \`${toolName}\``;

        if (toolName === 'write') {
          const filePath = (args['path'] ?? args['file_path'] ?? '') as string;
          const content = (args['content'] ?? '') as string;
          msg += `: ${filePath}`;
          if (content) {
            const preview = content.length > 400 ? content.substring(0, 400) + '\n…' : content;
            msg += `\n${preview}`;
          }
        } else if (toolName === 'edit') {
          const filePath = (args['path'] ?? args['file_path'] ?? '') as string;
          const edits: Array<{ oldText: string; newText: string }> = Array.isArray(args['edits'])
            ? args['edits'] as Array<{ oldText: string; newText: string }>
            : (args['oldText'] != null ? [{ oldText: args['oldText'] as string, newText: (args['newText'] ?? '') as string }] : []);
          msg += `: ${filePath}`;
          for (const edit of edits.slice(0, 2)) {
            const oldPreview = edit.oldText.length > 120 ? edit.oldText.substring(0, 120) + '…' : edit.oldText;
            const newPreview = edit.newText.length > 120 ? edit.newText.substring(0, 120) + '…' : edit.newText;
            msg += `\n- ${oldPreview.replace(/\n/g, '\n- ')}\n+ ${newPreview.replace(/\n/g, '\n+ ')}`;
          }
          if (edits.length > 2) msg += `\n…and ${edits.length - 2} more edit(s)`;
        } else {
          const firstArg = Object.values(args).find(v => typeof v === 'string') as string | undefined;
          if (firstArg) msg += `: ${firstArg.length > 60 ? firstArg.substring(0, 60) + '…' : firstArg}`;
        }

        logger.stream(label, msg);
      }
    });

    return {
      getTurnText: () => turnText,
      resetTurnText: () => { turnText = ''; modelActivitySeen = false; },
      getLastEventTime: () => lastEventTime,
      getLastPromptTokens: () => lastPromptTokens,
      hasThinkingLoop: () => thinkingLoopDetected,
      clearThinkingLoop: () => { resetTurnProgress(); },
      sawModelActivity: () => modelActivitySeen,
      dispose: () => { disposed = true; },
    };
  }

  /**
   * Adapt a reviewer session + stream handle pair to the minimal interface
   * ensureStructuredVerdict needs for its format-reminder retry.
   */
  private reviewerRetryHandle(
    session: { prompt(text: string): Promise<unknown> },
    handle: { getTurnText(): string; resetTurnText(): void },
  ): ReviewerSessionHandle {
    return {
      prompt: (text: string) => session.prompt(text),
      getTurnText: () => handle.getTurnText(),
      resetTurnText: () => handle.resetTurnText(),
    };
  }

  /** Post a full task checklist with live status icons so users can track progress. */
  private postChecklistUpdate(currentTaskId?: string): void {
    const subtasks = this.state.getState().subtasks;
    const completed = subtasks.filter(t => t.status === 'completed').length;
    const lines = subtasks.map(t => {
      if (t.status === 'completed') return `✅ **${t.id}**: ${t.description}`;
      if (t.status === 'failed')    return `❌ **${t.id}**: ${t.description}`;
      if (t.id === currentTaskId || t.status === 'in_progress')
        return `🔄 **${t.id}**: ${t.description}`;
      return `⬜ **${t.id}**: ${t.description}`;
    });
    this.chatMessage?.(`📋 **Progress** ${completed}/${subtasks.length}:\n${lines.join('\n')}`);
  }

  /**
   * Read .tdd-workflow/questions.md if an agent wrote it, post the questions to
   * chat, wait for the user's answer (outside the agent timeout), clear the file,
   * and return the answers string to be injected into the next attempt's feedback.
   * Returns null when there are no questions or no waitForInput handler is wired.
   */
  private async collectAgentQuestions(label: string): Promise<string | null> {
    const questionsPath = path.join(this.state.projectDir, '.tdd-workflow', 'questions.md');
    let questions: string;
    try {
      if (!fs.existsSync(questionsPath)) return null;
      questions = fs.readFileSync(questionsPath, 'utf-8').trim();
      if (!questions) return null;
    } catch {
      return null;
    }

    // Implementers sometimes write the file with a "no questions" sentinel
    // ("(No questions — all acceptance criteria met.)", "N/A", an empty bullet
    // list, etc.). The prompt now forbids this, but treat it as a no-op here
    // too so an obedience lapse doesn't halt the workflow.
    if (isNoQuestionsPlaceholder(questions)) {
      getLogger().info(`[${label}] questions.md held a "no questions" placeholder — ignoring and deleting`);
      try { fs.unlinkSync(questionsPath); } catch { /* non-fatal */ }
      return null;
    }

    // Clear immediately so stale questions don't bleed into the next attempt
    try { fs.unlinkSync(questionsPath); } catch { /* non-fatal */ }

    if (!this.waitForInput) {
      // No handler wired — log and skip
      getLogger().warn(`[${label}] Agent posted questions but no waitForInput handler is configured.`);
      this.chatMessage?.(`❓ **[${label}]** Agent has questions but no input handler is configured:\n\n${questions}`);
      return null;
    }

    this.chatMessage?.(
      `❓ **[${label}]** Agent has questions. Please answer below — the workflow will resume after your reply.\n\n${questions}`
    );

    const answer = await this.waitForInput(
      `Answer the ${label}'s questions above and press Enter:`
    );
    if (!answer?.trim()) return null;

    return `**User answers to agent questions:**\n${answer.trim()}`;
  }

  async startNew(request: string): Promise<void> {
    const logger = getLogger();
    logger.info(`Starting new workflow: ${request.substring(0, 100)}`);
    this.resumeMode = false;
    this.state.initWorkflow(request);

    // 1. Check if the request refers to a pre-planned Epic.
    // Skip the lookup for multiline/long requests — they are inline briefs (e.g. cleanup),
    // not epic references, and findEpic() throws on strings containing path separators.
    const epicLoader = new EpicLoader(this.state.projectDir);
    const mightBeEpicRef = !request.includes('\n') && request.length < 120;
    const epicPath = mightBeEpicRef ? epicLoader.findEpic(request) : null;
    let epic: EpicPlan | null = null;

    if (epicPath) {
      logger.info(`Detected pre-planned Epic: ${path.basename(epicPath)}`);
      epic = epicLoader.parseEpic(epicPath);
    }

    // 2. Initial planning or Epic loading
    if (epic) {
      logger.info(`✅ Successfully loaded Epic with ${epic.workItems.length} tasks: ${epic.title}`);
      this.state.updateRefinedRequest(epic.title);
      this.state.setSubtasks(epic.workItems.map(wi => ({
        id: wi.id,
        description: wi.description,
        status: 'pending',
        attempts: 0,
        acceptance: wi.acceptance,
        security: wi.security,
        tests: wi.tests,
        devNotes: wi.devNotes
      })));
    } else {
      // If the request looks like a bare epic reference (e.g. "1", "01", "epic-2") but no
      // WorkItems/ directory or matching file was found, fail fast with a clear message rather
      // than sending a meaningless string to the planner LLM.
      const looksLikeEpicRef = /^\s*(?:epic[-\s]*)?\d{1,3}\s*$/i.test(request);
      if (looksLikeEpicRef) {
        const msg =
          `No WorkItems directory found (or no epic matching "${request.trim()}"). ` +
          `Run /plan first to generate epics, then use /tdd <epic number> to execute one.`;
        this.chatMessage?.(msg);
        throw new Error(msg);
      }

      logger.warn(`⚠️ No pre-planned Epic found for "${request}". Falling back to on-the-fly decomposition.`);
      const plan = await planAndBreakdown(request, this.modelRouter, this.searchClient || undefined);
      this.state.updateRefinedRequest(plan.refinedRequest);

      if (plan.subtasks.length === 0) {
        const msg = `Planner returned 0 subtasks for request: "${request.substring(0, 80)}". ` +
          `Check .tdd-workflow/logs/ for the planner session dump.`;
        this.chatMessage?.(msg);
        throw new Error(msg);
      }

      this.state.setSubtasks(plan.subtasks);
    }

    // Mark coverage-focused tasks so the implementer verifies with the coverage command.
    for (const task of this.state.getState().subtasks) {
      if (/\bcoverage\b|\badd.*tests?\b|\bmissing tests?\b/i.test(task.description)) {
        this.state.updateSubtask(task.id, { requiresCoverageRun: true });
      }
    }

    // Post task checklist to chat so the user can track progress
    const subtasks = this.state.getState().subtasks;
    if (subtasks.length > 0) {
      this.chatMessage?.(
        `📋 **TDD Workflow** — ${subtasks.length} task${subtasks.length === 1 ? '' : 's'}:\n` +
        subtasks.map(t => `- [ ] **${t.id}**: ${t.description}`).join('\n')
      );
    }

    // Prompt the user to optionally create a feature branch for this workflow.
    // All task branches will merge into the feature branch rather than the current base.
    if (this.waitForInput) {
      const stateSnap = this.state.getState();
      const suggestedBranch = buildFeatureBranchName(stateSnap.original_request, stateSnap.refined_request);
      const answer = await this.waitForInput(
        `Create a feature branch for this epic?\n\n` +
        `Suggested: \`${suggestedBranch}\`\n\n` +
        `Type **y** to accept, a **custom branch name** to override, or **n** to work on the current branch:`
      );

      if (answer && answer.trim().toLowerCase() !== 'n' && answer.trim().toLowerCase() !== 'no') {
        const trimmed = answer.trim();
        const chosenBranch = (trimmed.toLowerCase() === 'y' || trimmed.toLowerCase() === 'yes')
          ? suggestedBranch
          : trimmed;

        try {
          sanitizeBranchName(chosenBranch); // validate before creating
          await this.sandbox.createBranch(chosenBranch);
          this.state.setFeatureBranch(chosenBranch);
          this.chatMessage?.(`🌿 Feature branch created: \`${chosenBranch}\`. Task branches will merge into it.`);
          getLogger().info(`Feature branch created: ${chosenBranch}`);
        } catch (err) {
          this.chatMessage?.(`⚠️ Could not create feature branch "${chosenBranch}": ${(err as Error).message}. Using current branch.`);
          getLogger().warn(`Feature branch creation failed: ${err}`);
        }
      } else {
        this.chatMessage?.(`ℹ️ Using current branch. Task branches will merge directly into it.`);
      }
    }

    await this.processQueue();
  }

  async resume(mode: 'skip' | 'retry' | 'resume' = 'skip'): Promise<void> {
    const logger = getLogger();

    if (!this.state.hasWorkflow()) {
      throw new Error('No workflow state found. Start a new workflow first.');
    }

    const resetInterrupted = this.state.resetInterruptedTasks();
    if (resetInterrupted > 0) {
      logger.info(`Resume check: Found ${resetInterrupted} tasks already in progress.`);
    }

    // Always pick up paused tasks — they were suspended by a deliberate user
    // action and represent WIP the user wants to continue. Unlike failed
    // tasks, they are picked up regardless of mode.
    const resumedPaused = this.state.resumePausedTasks();
    if (resumedPaused > 0) {
      // Paused tasks always run in resume mode (keep branch, preserve feedback).
      this.resumeMode = true;
      logger.info(`Resume check: Found ${resumedPaused} paused task(s) — continuing in resume mode`);
    }

    if (mode === 'retry') {
      this.resumeMode = false;
      const resetFailed = this.state.resetFailedTasks();
      logger.info(`Retry mode: reset ${resetFailed} failed tasks (feedback cleared)`);
    } else if (mode === 'resume') {
      this.resumeMode = true;
      const resumed = this.state.resumeFailedTasks();
      logger.info(`Resume mode: reset ${resumed} failed tasks (feedback preserved, branch kept)`);
    }
    // If mode === 'skip' and we already set resumeMode=true for paused tasks,
    // keep that. Otherwise leave resumeMode=false (the constructor default).

    await this.processQueue();
  }

  /**
   * Run (or retry) a single task by ID without touching any other tasks.
   * The task must already exist in the workflow state (i.e. the epic must have
   * been started at least once so its subtasks were planned and saved).
   * If the task is 'failed' or 'completed', it is reset to 'pending' first.
   */
  /**
   * Mark a task as externally completed (done manually outside the TDD agent)
   * then continue the rest of the epic with any remaining pending tasks.
   *
   * If the current branch looks like this task's WI branch (tdd-workflow/slug/WI-x),
   * automatically merges it into the feature branch (or reflog-detected parent branch)
   * before marking the task complete — matching what the normal TDD flow would do.
   */
  async markTaskDone(taskId: string): Promise<void> {
    const logger = getLogger();
    if (!this.state.hasWorkflow()) {
      throw new Error('No workflow state found. Start the epic first to generate its task list.');
    }
    const task = this.state.getSubtask(taskId);
    if (!task) {
      const ids = this.state.getState().subtasks.map(t => t.id).join(', ');
      throw new Error(`Task "${taskId}" not found. Available tasks: ${ids}`);
    }

    if (task.status !== 'completed') {
      // Check whether we're sitting on this task's WI branch and should merge it.
      const currentBranch = await this.sandbox.getCurrentBranch();
      const taskSlug = taskId.substring(0, 12);
      const isOnWiBranch = currentBranch.startsWith('tdd-workflow/') && currentBranch.endsWith(`/${taskSlug}`);

      if (isOnWiBranch) {
        // Determine the target branch: prefer the stored feature branch, then reflog.
        let targetBranch = this.state.getState().featureBranch ?? null;

        if (!targetBranch) {
          try {
            const { stdout } = await execFileAsync('git', ['reflog', 'show', '--pretty=%gs', currentBranch], {
              cwd: this.state.projectDir, timeout: 5000, maxBuffer: DEFAULT_MAX_BUFFER,
            });
            const created = stdout.split('\n').find(l => l.startsWith('branch: Created from'));
            if (created) targetBranch = created.replace('branch: Created from ', '').trim();
          } catch { /* non-fatal */ }
        }

        if (targetBranch) {
          this.chatMessage?.(`🔀 Merging \`${currentBranch}\` into \`${targetBranch}\`…`, 'tdd-orchestrator');
          try {
            await this.sandbox.mergeAndCleanup(currentBranch, targetBranch);
            this.chatMessage?.(`✅ Merged and branch deleted.`, 'tdd-orchestrator');
          } catch (mergeErr) {
            this.chatMessage?.(
              `⚠️ Merge failed: ${(mergeErr as Error).message}\n\nResolve conflicts manually, then re-run the command.`,
              'tdd-orchestrator'
            );
            throw mergeErr;
          }
        } else {
          this.chatMessage?.(
            `⚠️ On WI branch \`${currentBranch}\` but could not determine target branch — merge skipped. Merge manually if needed.`,
            'tdd-orchestrator'
          );
          logger.warn(`[markTaskDone] Could not determine target branch for merge of ${currentBranch}`);
        }
      }

      this.state.updateSubtask(taskId, { status: 'completed', tests_written: true, code_implemented: true });
      this.chatMessage?.(`✅ **${taskId}** marked as externally completed.`, 'tdd-orchestrator');
      this.events.emit('taskCompleted', { id: taskId, task: this.state.getSubtask(taskId) });
    } else {
      this.chatMessage?.(`Task **${taskId}** is already marked completed.`, 'tdd-orchestrator');
    }

    await this.resume('skip');
  }

  async runTask(taskId: string, mode: 'retry' | 'resume' = 'retry'): Promise<void> {
    const logger = getLogger();
    if (!this.state.hasWorkflow()) {
      throw new Error('No workflow state found. Start the epic first to generate its task list.');
    }
    const task = this.state.getSubtask(taskId);
    if (!task) {
      const ids = this.state.getState().subtasks.map(t => t.id).join(', ');
      throw new Error(`Task "${taskId}" not found. Available tasks: ${ids}`);
    }
    if (task.status !== 'pending') {
      if (mode === 'resume') {
        this.resumeMode = true;
        this.state.updateSubtask(taskId, { status: 'pending', attempts: 0, phase: undefined });
      } else {
        this.resumeMode = false;
        this.state.updateSubtask(taskId, { status: 'pending', attempts: 0, phase: undefined, feedback: undefined });
      }
      logger.info(`runTask: reset task "${taskId}" to pending (mode=${mode})`);
    }
    this.singleTaskId = taskId;
    try {
      await this.processQueue();
    } finally {
      this.singleTaskId = null;
    }
  }

  private async processQueue(): Promise<void> {
    const logger = getLogger();
    let consecutiveFailures = 0;

    // Reset interrupt state at the start of each run. A previous run's flags
    // could otherwise linger and immediately halt the new workflow.
    this.pauseRequested = false;
    this.stopRequested = false;
    this.modelUnreachableReason = null;

    // If a previous workflow left the repo on a tdd-workflow/* branch, switch to the
    // correct base before we do anything. If a feature branch was created for this
    // workflow, switch to that; otherwise find the repo's default base branch.
    const featureBranch = this.state.getState().featureBranch;
    try {
      await this.sandbox.ensureOnBaseBranch(featureBranch);
    } catch (err) {
      logger.warn(`[processQueue] Could not ensure base branch: ${err}`);
    }

    // Capture the git HEAD before any agents run — used by the final workflow review
    // to build a cumulative diff across all tasks.
    let workflowStartSha = '';
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: this.state.projectDir, timeout: 5000, maxBuffer: DEFAULT_MAX_BUFFER,
      });
      workflowStartSha = stdout.trim();
    } catch { /* non-fatal */ }

    const totalSubtasks = this.state.getState().subtasks.length;

    // Workflow-level token/time accounting. A per-task tracker is added for
    // each task; both receive every assistant message's usage via subscribeToSession.
    const workflowUsage = new UsageTracker();
    this.usageTrackers = [workflowUsage];

    // Capture each blocking gate's full output at baseline so we can compare
    // against it per-attempt. We don't just mask "was this gate failing?" —
    // we extract an error-signature set from each failing gate and only treat
    // errors that appear in the current run but NOT in the baseline as genuine
    // regressions. Otherwise a baseline of "3 tsc errors" would silently mask
    // an implementer that adds 7 more tsc errors.
    // Also collect a coverage baseline so the final reviewer can flag regressions.
    const baselineGateOutputs = new Map<string, string>();
    let baselineCoverage: CoverageMetrics | undefined;
    try {
      // fullScope: build/lint run across the WHOLE workspace (nx run-many), not
      // just the empty initial diff (nx affected). Otherwise the baseline records
      // zero pre-existing build/lint failures, and the first task that makes a
      // project "affected" surfaces that project's pre-existing warnings as if the
      // task introduced them. A full-scope baseline captures the real prior state.
      const baseline = await runQualityGates(this.state.projectDir, { collectCoverage: true, fullScope: true });
      baselineCoverage = baseline.coverageMetrics;
      const failing = baseline.gates.filter(g => g.blocking && !g.passed);
      for (const g of failing) baselineGateOutputs.set(g.gate, g.output);
      if (failing.length > 0) {
        const list = failing.map(g => g.gate).join(', ');
        logger.info(`Baseline blocking gate failures: ${list}`);
        this.chatMessage?.(
          `ℹ️ Pre-existing quality gate failures detected before any agent runs: **${list}**. ` +
          `Only NEW errors introduced by the implementer will block tasks — existing ones are ignored.`
        );
      }
      if (baselineCoverage) {
        logger.info(`Coverage baseline: lines=${baselineCoverage.lines}% functions=${baselineCoverage.functions}% branches=${baselineCoverage.branches}%`);
      }
    } catch (err) {
      logger.warn(`Could not capture quality gate baseline: ${err}`);
    }

    while (true) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(`Circuit breaker: ${consecutiveFailures} consecutive task failures.`);
        break;
      }

      // Outer-loop poll: if an interrupt landed between tasks, exit before
      // starting the next one. (Interrupts mid-task are handled inside the
      // inner loops below.)
      if (this.stopRequested || this.pauseRequested) {
        logger.info(`[EXECUTOR] Interrupt pending between tasks — exiting workflow`);
        break;
      }

      const task = this.singleTaskId
        ? (this.state.getSubtask(this.singleTaskId)?.status === 'pending' ? this.state.getSubtask(this.singleTaskId) : undefined)
        : this.state.getNextPendingTask();
      if (!task) break;

      logger.info(`\n--- Task ${task.id}: ${task.description.substring(0, 80)} ---`);

      // Only emit taskStarted if we are actually starting fresh
      if (task.status !== 'in_progress') {
        this.state.updateSubtask(task.id, { status: 'in_progress' });
        this.events.emit('taskStarted', { id: task.id, description: task.description });
        this.postChecklistUpdate(task.id);
      }

      const originalBranch = await this.sandbox.getCurrentBranch();
      const slug = workflowSlug(this.state.getState().original_request);
      const branchName = `tdd-workflow/${slug}/${task.id.substring(0, 12)}`;
      // Per-task token/time accounting (wall clock starts now).
      const taskUsage = new UsageTracker();
      this.usageTrackers = [workflowUsage, taskUsage];

      // Recurring-lesson injection: pick the lessons most relevant to this task
      // so the implementer avoids the mistakes reviewers keep flagging.
      let lessonsSection = '';
      try {
        const lessonStore = LessonStore.load(this.state.projectDir);
        const taskText = `${task.description} ${task.devNotes ?? ''} ${(task.acceptance ?? []).join(' ')}`;
        lessonsSection = LessonStore.renderForPrompt(lessonStore.selectForPrompt(taskText));
      } catch (err) {
        logger.warn(`[${task.id}] Could not load lessons: ${err}`);
      }
      let approved = false;
      // Set when the implementer model produces no response (ModelUnreachableError).
      // Gates the pass/attempt loops so we don't re-enter and recreate the session,
      // and triggers a clean connectivity-halt (task left pending, not failed).
      let haltSession = false;
      // Seed with any feedback preserved from a prior run (resume mode).
      let feedback = task.feedback || '';
      // In resume mode, preserve the existing task branch for the ENTIRE task
      // lifetime — not just attempt 1. If a runtime error rolls us back to the
      // base branch mid-task, the next attempt must still find the WIP where
      // the previous attempt left it. The README contract is "failed branch is
      // preserved exactly as the agent left it" — that applies across every
      // subsequent attempt, not only the first one.
      const preserveExistingBranch = this.resumeMode;

      // Capture lens state before any implementation work starts, so the reviewer
      // can compare against it to identify issues introduced by this task specifically.
      let lensBaseline = '';
      try { lensBaseline = await runLensAnalysis(this.state.projectDir); } catch { /* non-fatal */ }

      let lastAttemptDiff = '';
      let currentDiff = '';
      let changedFiles: string[] = [];
      let currentCommitLog = '';
      let lastAttemptBlockedByPreexisting = false;
      let lastQualityGatesPassed = false; // tracks whether the latest committed state passed QA
      const startAttempt = task.attempts || 1;
      // Session-refresh policy for the implementer model. Token-denominated
      // when the provider reports usage: refresh once the session's actual
      // prompt size crosses the threshold (default: half the model's window —
      // by then the history is mostly stale rounds, the avoidable kind of
      // context). The round cadence is only the fallback for providers that
      // report no usage.
      const implementerProfile = this.modelRouter.selectModel('implement');
      const effectiveRefreshAfter = implementerProfile.sessionRefreshAfter ?? SESSION_REFRESH_AFTER;
      const refreshTokenThreshold = implementerProfile.sessionRefreshTokens
        ?? Math.floor(implementerProfile.contextWindow / 2);
      // Implementer session is kept alive across reviewer-rejection retries so the agent
      // can continue patching its own work in a multi-turn conversation.
      // It is nulled out (and disposed) only when a runtime error forces a rollback.
      let implementerSession: AgentSession | null = null;
      // The stream handle is paired with the session lifetime — one subscription for the
      // whole lifetime of the session, with a per-turn text accumulator that we reset
      // before each prompt() call. This avoids the multi-subscribe bug where text
      // accumulated across turns and duplicated chat output.
      let implementerHandle: { getTurnText(): string; resetTurnText(): void; getLastEventTime(): number; getLastPromptTokens(): number; hasThinkingLoop(): boolean; clearThinkingLoop(): void; sawModelActivity(): boolean; dispose(): void } | null = null;

      // Fast-path: if resuming from a task that was already approved and just needs merging, skip all loops.
      if (task.phase !== 'merging') {
        // Accumulates one entry per implement→review cycle for arbiter loop detection.
        const iterationHistory: IterationRecord[] = [];
        // Per-round feedback log shown to the implementer on retries (newest first).
        const feedbackHistory: FeedbackRound[] = [];
        // Outer loop: pass 0 = normal attempts; passes 1..MAX_ARBITER_ROUNDS each
        // run a batch of arbiter-granted "continue" rounds, re-consulting the
        // arbiter after each batch. This lets genuine-but-slow progress keep going
        // past a single grant, while MAX_ARBITER_ROUNDS caps the total consults so
        // a stuck task can't loop forever.
        let arbiterExtraRounds = 0;
        let arbiterRounds = 0;             // arbiter consultations used so far
        let attemptCeiling = MAX_ATTEMPTS; // highest attempt number reached (cumulative numbering across passes)
        for (let pass = 0; pass <= MAX_ARBITER_ROUNDS && !approved && !haltSession; pass++) {
          if (pass > 0 && arbiterExtraRounds === 0) break;

          // Reset the cross-attempt similarity baseline when entering pass 1.
          // The user (or arbiter) just granted extra rounds — they're explicitly
          // giving the model another chance after seeing the prior diff. If we
          // leave lastAttemptDiff set to pass 0's final diff, the very first
          // extra attempt will almost certainly hit >90% similarity and bail
          // out, burning only 1 of the granted N rounds. Clearing it lets the
          // extra rounds actually run; the similarity check will rebuild from
          // attempt-to-attempt within pass 1.
          if (pass > 0) {
            lastAttemptDiff = '';
            lastAttemptBlockedByPreexisting = false;
          }

          const attemptStart = pass === 0 ? startAttempt : attemptCeiling + 1;
          const attemptEnd   = pass === 0 ? MAX_ATTEMPTS : attemptCeiling + arbiterExtraRounds;
          arbiterExtraRounds = 0;        // consumed for this pass; the next arbiter consult must re-grant
          attemptCeiling = attemptEnd;   // advance the numbering ceiling for the next pass

          for (let attempt = attemptStart; attempt <= attemptEnd && !approved && !haltSession; attempt++) {
            const totalMax = attemptEnd; // used for chat messages

        logger.info(`Attempt ${attempt}/${totalMax}`);
        this.state.updateSubtask(task.id, { attempts: attempt });

        try {
          let technicalDescription = task.description;

          // Phase 1: Refining
          if (!task.phase || task.phase === 'refining') {
            this.state.updateSubtask(task.id, { phase: 'refining' });
            this.events.emit('taskProgress', {
              id: task.id,
              attempt,
              phase: 'refining',
              message: 'Refining technical plan for implementation...'
            });
            technicalDescription = await this.refineTaskIntoSubtasks(task.id, attempt);
          }

          // Phase 2: Implementing
          let implementerSummary = '';
          if (!task.phase || task.phase === 'refining' || task.phase === 'implementing') {
            // Only touch the branch when we are not already on the task branch.
            // After a reviewer rejection we stay on the task branch so the implementer
            // can continue patching its own work rather than restarting from scratch.
            const currentBranch = await this.sandbox.getCurrentBranch();
            if (currentBranch !== branchName) {
              await this.sandbox.createBranch(branchName, {
                keepExisting: preserveExistingBranch,
                baseBranch: originalBranch,
              });
            }

            // Clear stale implementation notes so the reviewer always reads notes
            // that match the current diff, not a prior attempt's reasoning.
            try {
              const notesPath = path.join(this.state.projectDir, '.tdd-workflow', 'implementation-notes.md');
              if (fs.existsSync(notesPath)) fs.unlinkSync(notesPath);
            } catch { /* non-fatal */ }
            this.state.updateSubtask(task.id, { phase: 'implementing' });
            this.events.emit('taskProgress', {
              id: task.id,
              attempt,
              phase: 'implementing',
              message: feedback
                ? `Addressing reviewer feedback (patching existing implementation)...`
                : `Agent is building implementation (Read -> Test -> Code)...`
            });

            // Session refresh: replace the long-running session with a fresh one
            // when its context has grown mostly stale. Token-denominated when the
            // provider reports usage (one heavy thinking round can fill what five
            // light rounds wouldn't); round-cadence fallback otherwise. The fresh
            // session gets a compact "fixer" first-turn prompt with the ticket,
            // latest feedback, and a path to the on-disk feedback history file.
            let sessionWasReset = false;
            const refreshCheck = shouldRefreshSession({
              attempt,
              feedbackRounds: feedbackHistory.length,
              lastPromptTokens: implementerHandle?.getLastPromptTokens() ?? 0,
              refreshTokenThreshold,
              refreshAfterRounds: effectiveRefreshAfter,
            });
            if (implementerSession && refreshCheck.refresh) {
              const why = refreshCheck.reason === 'tokens'
                ? `context at ~${(implementerHandle?.getLastPromptTokens() ?? 0).toLocaleString()} tokens (threshold ${refreshTokenThreshold.toLocaleString()})`
                : `${effectiveRefreshAfter} feedback round(s) elapsed (provider reports no token usage)`;
              logger.info(`[${task.id}] Refreshing implementer session at attempt ${attempt} — ${why}`);
              this.chatMessage?.(
                `🔄 **[${task.id}]** Session reset at attempt ${attempt} — ${why}; history preserved on disk`,
                'tdd-implementer',
              );
              try { implementerHandle?.dispose(); } catch { /* best-effort */ }
              try { (implementerSession as AgentSession).dispose(); } catch { /* best-effort */ }
              implementerSession = null;
              implementerHandle = null;
              this.activeImplementerSession = null;
              this.activeImplementerHandle = null;
              sessionWasReset = true;
            }

            // Create the implementer session on the first attempt (or after a session reset).
            // On reviewer-rejection retries within the same window the session is reused
            // (multi-turn) so the agent has full context of its prior work.
            if (!implementerSession) {
              implementerSession = await createSubAgentSession({
                taskType: 'implement',
                systemPrompt: IMPLEMENTER_PROMPT,
                cwd: this.state.projectDir,
                modelRouter: this.modelRouter,
                notify: this.notifyUi,
                taskMetadata: {
                  acceptance: task.acceptance,
                  security: task.security,
                  tests: task.tests,
                  devNotes: task.devNotes,
                  testCommand: getTestCommand(this.state.projectDir),
                  packageManager: detectPackageManager(this.state.projectDir),
                  coverageCommand: task.requiresCoverageRun
                    ? getCoverageTestCommand(this.state.projectDir)
                    : undefined,
                },
              });
              implementerHandle = this.subscribeToSession(implementerSession, `Implementer ${task.id}`, 'tdd-implementer');
              // Expose for stop() to force-dispose from outside the task loop.
              this.activeImplementerSession = implementerSession;
              this.activeImplementerHandle = implementerHandle;
            }
            const handle = implementerHandle!;

            // Build the prompt for this turn.
            let implementerPrompt: string;
            if (sessionWasReset && feedback) {
              // Session-reset first turn: self-contained fixer prompt.
              // Write the full history to disk for reference, then include an
              // inline summary (bounded size) and the current diff so the model
              // has complete context without relying on conversation history.
              writeFeedbackHistory(task.id, feedbackHistory, this.state.projectDir);

              // Fetch the current diff to include inline (cap at ~6 KB to avoid flooding context).
              const MAX_DIFF_CHARS = 6000;
              let inlineDiff = '';
              try {
                const { stdout } = await execFileAsync(
                  'git', ['diff', originalBranch],
                  { cwd: this.state.projectDir, timeout: 10_000, maxBuffer: DEFAULT_MAX_BUFFER },
                );
                inlineDiff = stdout.trim();
                if (inlineDiff.length > MAX_DIFF_CHARS) {
                  inlineDiff = inlineDiff.slice(0, MAX_DIFF_CHARS) +
                    `\n… (diff truncated — run \`git diff ${originalBranch}\` to see the rest)`;
                }
              } catch { /* non-fatal — model can run git diff itself */ }

              this.chatMessage?.(
                `🔁 **[${task.id}]** Attempt ${attempt}/${totalMax} — fresh session, fixer prompt`,
              );

              implementerPrompt = buildFixerPrompt({
                task,
                technicalDescription,
                attempt,
                branchName,
                originalBranch,
                feedback,
                feedbackHistory,
                inlineDiff,
              });

            } else if (!sessionWasReset && feedback && attempt > 1) {
              // Retry turn within the same session: send reviewer/gate feedback as a
              // follow-up. The branch still has the previous implementation so the agent
              // only needs to apply the requested changes.
              this.chatMessage?.(
                `🔁 **[${task.id}]** Attempt ${attempt}/${totalMax} — continuing implementer session with reviewer feedback`
              );

              // Persist the full feedback to disk, then send only a short checklist
              // of this round's items — dumping every round's full text here was a
              // major context-bloat source (a test cascade → 100K+ tokens).
              writeFeedbackHistory(task.id, feedbackHistory, this.state.projectDir);
              implementerPrompt = buildRetryFeedbackPrompt(task.id, feedback, feedbackHistory.length);
            } else {
              // First turn: full task description + metadata + recurring lessons.
              implementerPrompt = buildInitialTaskPrompt(task, technicalDescription, lessonsSection);
            }

            // Run the implementer, then nudge it to keep going if it didn't signal DONE.
            // Cap nudges to avoid infinite loops on a truly stuck agent.
            // The total time budget for this attempt (initial prompt + all nudges) is
            // MAX_IMPLEMENTER_DURATION_MS as a single deadline — NOT a per-prompt timeout
            // re-armed on each nudge. Otherwise MAX_NUDGES × per-prompt timeouts could
            // compound into a 6-hour attempt.
            const MAX_NUDGES = 5;
            const MAX_IDLE_STEER_NUDGES = 3;
            const MAX_LOOP_ABORTS = 3;
            const attemptDeadline = Date.now() + MAX_IMPLEMENTER_DURATION_MS;
            let loopAbortCount = 0;        // per-attempt count across nudges
            let lastTurnAbortedForLoop = false; // set when watchdog aborts the in-flight turn

            for (let nudge = 0; nudge <= MAX_NUDGES; nudge++) {
              handle.resetTurnText();
              const remaining = attemptDeadline - Date.now();
              if (remaining <= 0) {
                throw new Error(`Implementer attempt exceeded deadline (${MAX_IMPLEMENTER_DURATION_MS / 60000} minutes)`);
              }

              // Watchdog: send a mid-turn steer nudge if the model goes silent,
              // OR call `session.abort()` if the model is cycling inside a thinking
              // block. `streamingBehavior: 'steer'` only queues a message — it does
              // NOT interrupt the current generation — so once the model is stuck
              // in a thinking loop the only reliable way out is to abort the turn.
              let idleTimer: ReturnType<typeof setTimeout> | null = null;
              let turnDone = false;
              let idleSteerCount = 0;
              let lastSteerTime = 0;
              const armIdleCheck = () => {
                idleTimer = setTimeout(async () => {
                  if (turnDone) return;

                  // Priority check 1: thinking loop — abort the in-flight turn so
                  // the prompt() resolves and we can send a fresh anti-loop nudge.
                  if (handle.hasThinkingLoop()) {
                    if (loopAbortCount >= MAX_LOOP_ABORTS) {
                      logger.error(`[${task.id}] Thinking loop persists after ${MAX_LOOP_ABORTS} aborts — disposing session to end attempt`);
                      this.chatMessage?.(
                        `🚨 **[${task.id}]** Model keeps entering thinking loops despite aborts — ending this attempt`,
                        'tdd-implementer',
                      );
                      turnDone = true;
                      handle.clearThinkingLoop();
                      try { implementerSession?.dispose(); } catch { /* dispose may throw if already gone */ }
                      return;
                    }
                    loopAbortCount++;
                    lastTurnAbortedForLoop = true;
                    logger.warn(`[${task.id}] Thinking loop detected — calling session.abort() (${loopAbortCount}/${MAX_LOOP_ABORTS})`);
                    this.chatMessage?.(
                      `🔁 **[${task.id}]** Thinking loop detected — aborting turn and steering`,
                      'tdd-implementer',
                    );
                    handle.clearThinkingLoop();
                    // abort() cancels the agent's current generation and resolves the
                    // pending prompt() promise. Fire-and-forget — the watchdog finishes;
                    // the awaiting prompt() at the bottom of this iteration unblocks.
                    implementerSession?.abort().catch((err: unknown) => {
                      logger.warn(`[${task.id}] session.abort() failed: ${err}`);
                    });
                    return;
                  }

                  // Priority check 2: idle (genuine silence — no events at all).
                  const silentMs = Date.now() - handle.getLastEventTime();
                  const sinceLastSteer = Date.now() - lastSteerTime;
                  if (
                    silentMs >= IDLE_NUDGE_MS &&
                    sinceLastSteer >= IDLE_NUDGE_MS &&
                    idleSteerCount < MAX_IDLE_STEER_NUDGES
                  ) {
                    idleSteerCount++;
                    lastSteerTime = Date.now();
                    const silentMin = Math.round(silentMs / 60_000);
                    logger.info(`[${task.id}] No output for ${silentMin}m — idle steer-nudge ${idleSteerCount}/${MAX_IDLE_STEER_NUDGES}`);
                    this.chatMessage?.(
                      `⏱️ **[${task.id}]** Silent for ${silentMin} minutes — nudging to continue (${idleSteerCount}/${MAX_IDLE_STEER_NUDGES})`,
                      'tdd-implementer',
                    );
                    implementerSession!.prompt(
                      'You have been silent for several minutes. Continue your work — write code, run tests, commit, then end with `DONE: <summary>`.',
                      { streamingBehavior: 'steer' },
                    ).catch(() => {});
                  }
                  if (!turnDone) armIdleCheck();
                }, 60_000);
              };
              armIdleCheck();

              try {
                await withTimeout(
                  this.promptUntilIdle(implementerSession, implementerPrompt),
                  remaining,
                  `Implementer timed out after ${MAX_IMPLEMENTER_DURATION_MS / 60000} minutes (across ${nudge + 1} prompt(s))`,
                );
              } finally {
                turnDone = true;
                if (idleTimer) clearTimeout(idleTimer);
              }

              // Interrupt check after each prompt returns: pause + stop both
              // bail out of the nudge loop. Stop additionally throws (caught
              // by the outer try/catch which handles session disposal + rollback).
              // These take priority over the no-response guard below — a user
              // interrupt is intentional, not a connectivity failure.
              if (this.stopRequested) {
                throw new Error('__STOP_REQUESTED__');
              }
              if (this.pauseRequested) break;

              if (/^DONE:/im.test(handle.getTurnText())) break;

              // Fast-fail: a turn that produced NO model output at all — no text,
              // no tool calls, no thinking — means the provider was never reached
              // (or errored before emitting anything): the endpoint is down or the
              // configured model id doesn't resolve. That's a connectivity/config
              // problem, not a task to retry, so halt the whole session instead of
              // nudging an empty void up to MAX_NUDGES times.
              if (!handle.sawModelActivity() && !handle.getTurnText().trim()) {
                throw new ModelUnreachableError(
                  `Implementer model produced no response for task ${task.id} ` +
                  `(no provider output on attempt ${attempt}, nudge ${nudge}). ` +
                  `The model endpoint may be down, or the configured model id may not match what it serves.`,
                );
              }

              if (nudge < MAX_NUDGES) {
                logger.info(`[${task.id}] Implementer did not signal DONE — nudging (${nudge + 1}/${MAX_NUDGES})`);
                this.chatMessage?.(`⏩ **[${task.id}]** Implementer hasn't finished — nudging to continue (${nudge + 1}/${MAX_NUDGES})`, 'tdd-implementer');
                if (lastTurnAbortedForLoop) {
                  implementerPrompt = ANTI_LOOP_NUDGE_PROMPT;
                  lastTurnAbortedForLoop = false;
                } else {
                  implementerPrompt = CONTINUE_NUDGE_PROMPT;
                }
              } else {
                logger.warn(`[${task.id}] Implementer never signalled DONE after ${MAX_NUDGES} nudges — proceeding to quality gates anyway`);
              }
            }

            // Capture the implementer's DONE summary for arbiter loop detection.
            implementerSummary = handle.getTurnText();

            // Interrupt check at the end of the implementer phase: if a pause
            // landed during the current turn, stop here before spending budget
            // on quality gates + reviewer.
            if (this.stopRequested) throw new Error('__STOP_REQUESTED__');
            if (this.pauseRequested) break;

            // Collect any questions the implementer wrote (outside the timeout — user
            // interaction time doesn't count against the agent's session budget).
            const implementerAnswers = await this.collectAgentQuestions(`Implementer ${task.id}`);
            if (implementerAnswers) {
              feedback = feedback ? `${feedback}\n\n${implementerAnswers}` : implementerAnswers;
            }

            // Capture the full WI-branch diff for loop detection and reviewer context.
            {
              const captured = await this.captureBranchDiff(originalBranch, task.id);
              currentDiff = captured.diff;
              changedFiles = captured.changedFiles;
              // Stash the commit log on a closure-scoped var so the prompt builder
              // below can pick it up. (Kept separate from currentDiff because the
              // log goes into its own section, not the diff fence.)
              currentCommitLog = captured.commitLog;
            }

            // Only treat high cross-attempt similarity as a loop when the PREVIOUS
            // attempt's gates PASSED — i.e. a reviewer-rejection loop on working
            // code. When the prior attempt FAILED its gates, the implementer is
            // iterating on a fix, where a near-identical full-branch diff is
            // expected (most of the diff is the same feature; only the fix
            // differs). Bailing here would skip THIS attempt's quality gates and
            // reviewer and leave lastQualityGatesPassed stale, so the arbiter then
            // judges a stale state. Let the gates evaluate the fix instead.
            if (lastAttemptDiff && currentDiff && !lastAttemptBlockedByPreexisting && lastQualityGatesPassed) {
              const similarity = outputSimilarity(lastAttemptDiff, currentDiff);
              if (similarity > SIMILARITY_THRESHOLD) {
                logger.warn(`Loop detected: attempt ${attempt} output is ${(similarity * 100).toFixed(0)}% similar to previous attempt (gates were passing — reviewer-rejection loop). Bailing early.`);
                feedback = `Agent is producing nearly identical output across attempts (${(similarity * 100).toFixed(0)}% similarity). Manual intervention required.`;
                this.events.emit('taskProgress', {
                  id: task.id,
                  attempt,
                  phase: 'implementing',
                  message: `⚠️ Loop detected — agent is repeating itself. ${feedback}`,
                  isError: true,
                });
                break;
              }
            }
            lastAttemptBlockedByPreexisting = false; // reset for next iteration
            lastAttemptDiff = currentDiff;
          }

          // Phase 3: Quality Gates
          if (!task.phase || task.phase === 'refining' || task.phase === 'implementing' || task.phase === 'quality_gates') {
            this.state.updateSubtask(task.id, { phase: 'quality_gates' });
            this.events.emit('taskProgress', {
              id: task.id,
              attempt,
              phase: 'quality-gates',
              message: 'Verifying implementation (TSC, Tests, Lint)...'
            });
            const qualityReport = await runQualityGates(this.state.projectDir);

            // Parse and format coverage results if available
            let coverageInfo = '';
            if (qualityReport.coverageMetrics) {
              const m = qualityReport.coverageMetrics;
              coverageInfo = `Coverage: ${m.lines}% lines, ${m.functions}% functions, ${m.branches}% branches`;
            }

            if (!qualityReport.allBlockingPassed) {
              // Compare each failing blocking gate against the baseline — only
              // genuinely NEW errors block the implementer (see gate-evaluation.ts).
              const { regressionGates, regressionReports, preexistingGates } =
                evaluateGateFailures(qualityReport.gates, baselineGateOutputs);

              if (regressionGates.length === 0) {
                // Every blocking failure is pre-existing — treat as passed.
                logger.info(`All blocking gate failures are pre-existing (${preexistingGates.join(', ')}) — treating as passed for this task.`);
                this.chatMessage?.(
                  `**[${task.id}]** ℹ️ All blocking failures are pre-existing (${preexistingGates.join(', ')}) — not caused by this task's changes. Proceeding.`
                );
                lastAttemptBlockedByPreexisting = true;
                // Fall through to commit / reviewer as if gates passed.
              } else {
                // There are genuine new failures. Build feedback from those only.
                feedback = regressionReports.join('\n\n');
                feedbackHistory.push({ round: attempt, type: 'gates', text: feedback });
                logger.info(`Quality gates failed (new failures only):\n${feedback.substring(0, 300)}`);

                // Emit detailed feedback for TUI
                this.events.emit('taskProgress', {
                  id: task.id,
                  attempt,
                  phase: 'quality-gates',
                  message: `❌ Quality gates failed. Feedback sent to agent.\n${feedback}`,
                  isError: true
                });

                lastQualityGatesPassed = false;
                if (attempt < totalMax) {
                  const fbPreview = feedback.length > 500 ? feedback.substring(0, 500) + '…' : feedback;
                  this.chatMessage?.(
                    `**[${task.id}]** ❌ Quality gates failed (attempt ${attempt}/${totalMax}) — sending to agent for retry:\n\`\`\`\n${fbPreview}\n\`\`\``
                  );
                }
                lastAttemptBlockedByPreexisting = false;

                iterationHistory.push({
                  attempt,
                  implementerSummary: implementerSummary || '(no DONE message captured)',
                  reviewerFeedback: `Quality gates failed: ${regressionReports.join(' | ').substring(0, 300)}`,
                });

                this.state.updateSubtask(task.id, { phase: undefined });
                continue;
              }
            }

            // Commit passing code
            lastQualityGatesPassed = true;
            await this.sandbox.commit(`TDD [Attempt ${attempt}]: ${task.description.substring(0, 50)}`, {
              attempt,
              gateResults: qualityReport.gates.map(g => ({ gate: g.gate, passed: g.passed, blocking: g.blocking })),
              testMetrics: qualityReport.testMetrics,
              coverageMetrics: qualityReport.coverageMetrics,
              usageSummary: taskUsage.summaryLine() || undefined,
            });

            this.events.emit('taskProgress', {
              id: task.id,
              attempt,
              phase: 'quality-gates',
              message: `✅ Quality gates passed! ${coverageInfo}`
            });
          }

          // Interrupt check before we spend reviewer budget. Stop → throw so
          // the outer catch rolls the branch back; pause → break out cleanly
          // (the passing commit is preserved and we'll resume into the
          // reviewer next time).
          if (this.stopRequested) throw new Error('__STOP_REQUESTED__');
          if (this.pauseRequested) break;

          // Phase 4: Reviewing — runs for every task before merge
          {
            // Resume safety net: when the workflow resumes directly into the
            // reviewing phase (task.phase was 'reviewing'/'quality_gates' at
            // restart), the implement block above — which checks out the task
            // branch and captures the diff — is skipped. The resume path leaves
            // the repo on the BASE branch (see ensureOnBaseBranch), so without
            // this the reviewer inspects the base branch with an empty diff and
            // reports "no implementation exists" even though the work is committed
            // on the task branch. Ensure we're on the task branch and have a diff
            // before the reviewer looks at the tree.
            const reviewBranch = await this.sandbox.getCurrentBranch();
            if (reviewBranch !== branchName) {
              logger.warn(`[${task.id}] Reviewing on "${reviewBranch}", not task branch "${branchName}" (resumed past implement) — checking out task branch`);
              await this.sandbox.safeCheckout(branchName);
            }
            if (!currentDiff.trim() && changedFiles.length === 0) {
              const captured = await this.captureBranchDiff(originalBranch, task.id);
              currentDiff = captured.diff;
              changedFiles = captured.changedFiles;
              currentCommitLog = captured.commitLog;
            }

            this.state.updateSubtask(task.id, { phase: 'reviewing' });
            const subtask = task!;
            this.events.emit('taskProgress', {
              id: subtask.id,
              attempt,
              phase: 'reviewing',
              message: 'Waiting for hostile code review...'
            });

            const reviewerSession = await createSubAgentSession({
              taskType: 'review',
              systemPrompt: REVIEWER_PROMPT,
              cwd: this.state.projectDir,
              modelRouter: this.modelRouter,
              notify: this.notifyUi,
              tools: 'review'
            });
            const reviewerHandle = this.subscribeToSession(reviewerSession, `Reviewer ${task.id}`, 'tdd-reviewer');

            let reviewText = '';
            try {
              // Read implementer notes if the agent wrote them
              let implementerNotes = '';
              try {
                const notesPath = path.join(this.state.projectDir, '.tdd-workflow', 'implementation-notes.md');
                if (fs.existsSync(notesPath)) {
                  implementerNotes = fs.readFileSync(notesPath, 'utf-8').trim();
                }
              } catch { /* non-fatal */ }

              // Capture lens state after implementation so the reviewer can judge
              // whether new structural/type issues were introduced by this task.
              let lensAfter: string | null = null;
              try {
                lensAfter = await runLensAnalysis(this.state.projectDir);
              } catch { /* non-fatal — omit lens section */ }

              const reviewPrompt = buildTaskReviewPrompt({
                taskDescription: task.description,
                implementerNotes,
                commitLog: currentCommitLog,
                originalBranch,
                changedFiles,
                diff: currentDiff,
                lensBaseline,
                lensAfter,
              });

              await withTimeout(
                this.promptUntilIdle(reviewerSession, reviewPrompt),
                MAX_REVIEWER_DURATION_MS,
                `Reviewer timed out after ${MAX_REVIEWER_DURATION_MS / 60000} minutes`,
              );

              // If the reviewer analysed but didn't produce the required verdict
              // format, ensureStructuredVerdict sends one format-reminder follow-up.
              reviewText = await ensureStructuredVerdict(
                this.reviewerRetryHandle(reviewerSession, reviewerHandle),
                reviewerHandle.getTurnText(),
                task.id,
              );
            } finally {
              reviewerHandle.dispose();
              reviewerSession.dispose();
              logger.info('[EXECUTOR] Reviewer disposed. Cooldown for slot recovery...');
              await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
            }

            // Collect any questions the reviewer wrote (outside the timeout)
            const reviewerAnswers = await this.collectAgentQuestions(`Reviewer ${task.id}`);

            const { approved: isApproved, feedback: reviewerFeedback } = parseReviewerVerdict(reviewText);

            if (!isApproved) {
              logger.info(`Review rejected: ${reviewerFeedback.substring(0, 200)}`);
              feedback = reviewerAnswers
                ? `${reviewerFeedback}\n\n${reviewerAnswers}`
                : reviewerFeedback;
              feedbackHistory.push({ round: attempt, type: 'review', text: feedback });

              iterationHistory.push({
                attempt,
                implementerSummary: implementerSummary || '(no DONE message captured)',
                reviewerFeedback,
              });

              // Emit detailed feedback for TUI
              this.events.emit('taskProgress', {
                id: task.id,
                attempt,
                phase: 'reviewing',
                message: `❌ Review rejected. Feedback sent to agent.\n\n${feedback}`,
                isError: true
              });

              if (attempt < totalMax) {
                const fbPreview = feedback.length > 500 ? feedback.substring(0, 500) + '…' : feedback;
                this.chatMessage?.(
                  `**[${task.id}]** ❌ Review rejected (attempt ${attempt}/${totalMax}) — sending to agent for retry:\n\n${fbPreview}`
                );
              }

              this.state.updateSubtask(task.id, { phase: undefined });
              continue;
            }

            approved = true;
            this.state.updateSubtask(task.id, { phase: 'merging' });
          }

          // NOTE: Phase 5 (Merge) is outside the attempt loops — see below.

        } catch (err) {
          const isStopSignal = err instanceof Error && err.message === '__STOP_REQUESTED__';
          const isModelUnreachable = err instanceof ModelUnreachableError;
          if (isModelUnreachable) {
            logger.error(`[EXECUTOR] Implementer model unreachable — halting session: ${(err as Error).message}`);
            this.modelUnreachableReason = (err as Error).message;
            haltSession = true;
            // Deliberately NOT a task failure: leave `feedback` unset so the
            // post-loop handler resets the task to pending, not failed.
          } else if (isStopSignal) {
            logger.info(`[EXECUTOR] Stop signal caught — disposing session and rolling back ${task.id}`);
          } else {
            logger.error(`Attempt ${attempt} error: ${err}`);
            feedback = `Runtime error: ${err}`;
          }
          // Dispose the implementer session on error — the branch will be rolled back
          // so the session's in-flight context is no longer valid.
          if (implementerSession) {
            try { implementerHandle?.dispose(); } catch { }
            try { implementerSession.dispose(); } catch { }
            implementerHandle = null;
            implementerSession = null;
            this.activeImplementerSession = null;
            this.activeImplementerHandle = null;
            logger.info('[EXECUTOR] Implementer session disposed after error.');
            await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
          }
          try { await this.sandbox.rollback(originalBranch); } catch { }
          // If stop was requested, break out of the attempt loop — the outer
          // task-level handler (after the pass loop) resets the task to pending
          // and exits the workflow.
          if (isStopSignal || isModelUnreachable) break;
        }
          } // end inner attempt for-loop

          // After each pass's attempts, consult the arbiter to decide what happens
          // next (continue with more rounds, approve, or escalate) — up to
          // MAX_ARBITER_ROUNDS times, so it can keep granting "continue" while real
          // progress is being made. Skip when a pause/stop interrupt is pending —
          // the user has told us to halt, not spend more budget on another agent.
          if (!approved && !haltSession && !this.stopRequested && !this.pauseRequested && arbiterRounds < MAX_ARBITER_ROUNDS) {
            arbiterRounds++;
            // Quiesce the implementer first. session.prompt() can resolve while
            // the underlying agent is still streaming (we've observed implementer
            // events firing minutes after its last prompt supposedly returned),
            // which lets the implementer keep generating in parallel with the
            // arbiter and produce confusing interleaved output. abort() blocks
            // until the agent is idle, so calling it here guarantees a single
            // active model at a time.
            if (implementerSession) {
              try {
                await (implementerSession as any).abort?.();
                logger.info(`[${task.id}] Implementer aborted prior to arbiter call.`);
              } catch (err) {
                logger.warn(`[${task.id}] implementer.abort() before arbiter failed: ${err}`);
              }
            }

            const arbiterDecision = await this.runArbiter(task, currentDiff, changedFiles, feedback, lastQualityGatesPassed, iterationHistory);
            if (arbiterDecision.decision === 'approve' && lastQualityGatesPassed) {
              approved = true; // gates green + arbiter approves → fall through to Phase 5 merge
            } else if (arbiterDecision.decision === 'continue') {
              arbiterExtraRounds = arbiterDecision.rounds;
            } else {
              // Escalate to the user. This covers both an explicit `escalate`
              // verdict AND the case where the arbiter wanted to approve but
              // quality gates never passed — the arbiter is barred from approving
              // failing gates (see ARBITER_PROMPT), but the *user* is the final
              // authority and may override.
              const rationale = arbiterDecision.decision === 'approve'
                ? `${arbiterDecision.rationale} (arbiter wanted to approve, but quality gates never passed — only you can override)`
                : arbiterDecision.rationale;
              const userDecision = await this.handleArbiterEscalation(task, currentDiff, feedback, rationale);
              if (userDecision.action === 'approve') {
                // Honor an explicit user approve even when gates are red: they've
                // seen the diff and the failing feedback and chosen to merge as-is.
                // Failing-gate attempts don't auto-commit, so capture the current
                // working tree first to guarantee there's something to merge.
                if (!lastQualityGatesPassed) {
                  this.chatMessage?.(
                    `⚠️ **[${task.id}]** Approving with **failing quality gates** at your request — merging as-is. ` +
                    `Build/tests/lint may be broken on \`${originalBranch}\` until fixed.`,
                    'tdd-arbiter',
                  );
                  try {
                    await this.sandbox.commit(`TDD [user-approved, failing gates]: ${task.description.substring(0, 50)}`);
                  } catch (err) {
                    getLogger().warn(`[${task.id}] commit before user-override approve failed (working tree may already be committed): ${err}`);
                  }
                }
                approved = true;
              } else if (userDecision.action === 'continue') {
                arbiterExtraRounds = userDecision.rounds;
              }
              // else stop: leave approved=false, loop exits, task fails
            }
          }
        } // end outer pass for-loop

        // Dispose the implementer session now that all attempts for this task are done.
        if (implementerSession) {
          try { implementerHandle?.dispose(); } catch { }
          try { implementerSession.dispose(); } catch { }
          implementerHandle = null;
          implementerSession = null;
          this.activeImplementerSession = null;
          this.activeImplementerHandle = null;
          logger.info('[EXECUTOR] Implementer session disposed after task completion.');
          await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
        }

        // Self-learning: distill this task's feedback rounds into reusable
        // lessons for future tasks. Only runs when there was actual feedback
        // (clean first-pass approvals teach nothing). Fail-soft and skipped on
        // interrupts/connectivity halts — never blocks workflow bookkeeping.
        if (feedbackHistory.length > 0 && !haltSession && !this.stopRequested && !this.pauseRequested) {
          await this.extractLessonsFromTask(task.id, feedbackHistory);
        }
      } // end if (task.phase !== 'merging')

      // Phase 5: Merge — runs once approved (by reviewer, arbiter, or user) OR when resuming from 'merging' phase.
      if (approved || task.phase === 'merging') {
        this.events.emit('taskProgress', {
          id: task.id,
          attempt: task.attempts || 1,
          phase: 'merging',
          message: 'Review approved! Merging changes into main branch...'
        });
        await this.sandbox.mergeAndCleanup(branchName, originalBranch);
        this.state.updateSubtask(task.id, {
          status: 'completed',
          tests_written: true,
          code_implemented: true,
          phase: undefined
        });
        logger.info(`Task ${task.id} completed and merged!`);
        if (taskUsage.hasData()) {
          this.chatMessage?.(`📊 **${task.id}** usage: ${taskUsage.summaryLine()}`, 'tdd-orchestrator');
        }
        const completedTask = this.state.getState().subtasks.find(t => t.id === task.id);
        this.postChecklistUpdate();
        if (completedTask) {
          this.events.emit('taskCompleted', { id: task.id, task: completedTask });
        }
        approved = true; // ensure correct path below for resuming tasks
      }

      // Model-unreachable halt takes priority: this is a "could not connect to
      // the model" situation, NOT a failed run. Roll back, leave the task
      // PENDING (not failed), tell the user it's an endpoint/config problem, and
      // stop the whole TDD session.
      if (haltSession) {
        this.state.updateSubtask(task.id, {
          status: 'pending',
          attempts: 0,
          phase: undefined,
          feedback: undefined,
        });
        this.chatMessage?.(
          `🔌 **Could not reach the implementer model — TDD session stopped.**\n` +
          `${this.modelUnreachableReason ?? ''}\n` +
          `Task \`${task.id}\` was rolled back to \`${originalBranch}\` and left **pending** (not failed). ` +
          `Check that the model endpoint is up and the configured model id matches what it serves, then re-run.`,
          'tdd-orchestrator',
        );
        this.events.emit('taskStopped', { id: task.id });
        this.postChecklistUpdate();
        break;
      }

      // User interrupt handling takes priority over approved/failed bookkeeping.
      // Both stop and pause exit the workflow; the difference is how the current
      // task is marked and whether the branch survives.
      if (this.stopRequested) {
        // The catch block already disposed the session and rolled back; reset
        // the task so the repo looks as if this run never happened.
        this.state.updateSubtask(task.id, {
          status: 'pending',
          attempts: 0,
          phase: undefined,
          feedback: undefined,
        });
        this.chatMessage?.(
          `🛑 **Stopped.** Task \`${task.id}\` was rolled back to \`${originalBranch}\`. ` +
          `Run \`/tdd ${this.state.getState().original_request.split('\n')[0]!.substring(0, 60).trim()}\` ` +
          `to start fresh, or \`/tdd <epic> resume\` to continue from the next pending task.`,
          'tdd-orchestrator'
        );
        this.events.emit('taskStopped', { id: task.id });
        this.postChecklistUpdate();
        break;
      }
      if (this.pauseRequested) {
        // Pause: preserve WIP. Keep the task branch intact, preserve attempts +
        // feedback, and mark the task `paused`. Resumable via `/tdd N resume`.
        this.state.updateSubtask(task.id, { status: 'paused', phase: undefined });
        const epicRef = this.state.getState().original_request.split('\n')[0]!.substring(0, 60).trim();
        this.chatMessage?.(
          `⏸ **Paused.** Task \`${task.id}\` is at attempt ${task.attempts || 1} on branch \`${branchName}\` — WIP preserved. ` +
          `Run \`/tdd ${epicRef} resume\` (or \`/tdd:resume\`) to continue where you left off.`,
          'tdd-orchestrator'
        );
        this.events.emit('taskPaused', { id: task.id, branch: branchName });
        this.postChecklistUpdate();
        break;
      }

      if (approved) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        this.state.updateSubtask(task.id, { status: 'failed', feedback });
        const failedTask = this.state.getState().subtasks.find(t => t.id === task.id);
        const failureMessage = `${feedback}\n\nWork halted for manual inspection on branch: ${branchName}`;

        // Post failure summary to chat with inspection pointers and resume instructions.
        // Use only the first line of original_request as the epic ref — it may be a
        // multiline brief (e.g. from /tdd:project-cleanup) and we don't want to embed it.
        const rawRequest = this.state.getState().original_request.trim();
        const epicRef = rawRequest.includes('\n')
          ? rawRequest.split('\n')[0]!.substring(0, 60).trim()
          : rawRequest.substring(0, 60).trim();
        const feedbackPreview = feedback.length > 300 ? feedback.substring(0, 300) + '…' : feedback;
        const usageLine = taskUsage.hasData() ? `**Usage:** ${taskUsage.summaryLine()}\n\n` : '';
        this.chatMessage?.(
          `❌ **${task.id}** failed after ${task.attempts || MAX_ATTEMPTS} attempts: ${task.description}\n\n` +
          `**Feedback:** ${feedbackPreview}\n\n` +
          usageLine +
          `**Inspect:** branch \`${branchName}\` · State: \`.tdd-workflow/state.json\` · Logs: \`.tdd-workflow/logs/\`\n\n` +
          `**Next step:**\n` +
          `- \`/tdd ${epicRef} resume\` — retry with reviewer feedback preserved _(recommended)_\n` +
          `- \`/tdd ${epicRef} retry\` — retry with a clean slate (feedback cleared)\n` +
          `- \`/tdd ${epicRef} continue\` — skip failed tasks and proceed`
        );

        this.events.emit('taskFailed', {
          id: task.id,
          task: failedTask,
          feedback: failureMessage,
          isCircuitBroken: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
          originalBranch
        });

        // Stop the workflow — user must explicitly resume via /tdd <epic> resume|retry|continue
        break;
      }
    }

    // Drop the last task's tracker — final-review usage counts toward the workflow only.
    this.usageTrackers = [workflowUsage];

    // Final workflow review: runs after all tasks complete, sees the full cumulative diff.
    // Per-task reviewers approved each story individually; this is an additional holistic
    // check across all changes. A rejection here is advisory — all changes are already merged.
    const allCompleted = this.state.getState().subtasks.every(t => t.status === 'completed');
    if (allCompleted && totalSubtasks > 1) {
      await this.runFinalWorkflowReview(workflowStartSha, baselineCoverage);
    }

    this.usageTrackers = [];
    if (workflowUsage.hasData()) {
      this.chatMessage?.(`📊 **Workflow usage:** ${workflowUsage.summaryLine()}`, 'tdd-orchestrator');
    }
  }

  /**
   * Run a single reviewer over the full cumulative diff after all tasks have been individually
   * reviewed and merged. Sees the coherent finished state across all tasks.
   * A rejection here is advisory — all quality gates have already passed and changes are
   * merged. The feedback is posted to chat for the user to act on.
   */
  /**
   * Run the hostile reviewer against an arbitrary diff outside the TDD cycle.
   *
   * @param scope  'uncommitted' | 'N' (last N commits as string) | 'all' (since branch base) | 'branch:<name>' | 'parent-branch'
   * @param context  Optional free-text description or pre-formatted epic context
   */
  async runStandaloneReview(scope: string, context?: string): Promise<void> {
    const logger = getLogger();

    // ── 1. Get diff ────────────────────────────────────────────────────────
    let diff = '';
    let changedFiles: string[] = [];
    let scopeLabel = '';

    try {
      let baseRef: string;

      if (scope === 'uncommitted') {
        baseRef = 'HEAD';
        scopeLabel = 'uncommitted changes';
      } else if (scope === 'all') {
        scopeLabel = 'all changes since branch base';
        // Find the common ancestor with main / master
        const tryBase = async (branch: string) => {
          const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', branch], {
            cwd: this.state.projectDir, timeout: 5000, maxBuffer: DEFAULT_MAX_BUFFER,
          });
          return stdout.trim();
        };
        try { baseRef = await tryBase('main'); }
        catch { try { baseRef = await tryBase('master'); }
          catch { baseRef = 'HEAD~20'; scopeLabel += ' (fallback: last 20 commits)'; } }
      } else if (scope === 'parent-branch') {
        let parentBranch: string | null = null;
        try {
          const { stdout: reflogOut } = await execFileAsync('git', ['reflog', 'show', '--pretty=%gs', 'HEAD'], {
            cwd: this.state.projectDir, timeout: 5000, maxBuffer: DEFAULT_MAX_BUFFER,
          });
          const createdLine = reflogOut.split('\n').find(l => l.startsWith('branch: Created from'));
          if (createdLine) {
            parentBranch = createdLine.replace('branch: Created from ', '').trim();
          }
        } catch { /* non-fatal — fall through to main/master */ }

        if (parentBranch) {
          scopeLabel = `all changes vs parent branch "${parentBranch}"`;
          try {
            const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', parentBranch], {
              cwd: this.state.projectDir, timeout: 5000, maxBuffer: DEFAULT_MAX_BUFFER,
            });
            baseRef = stdout.trim();
          } catch {
            throw new Error(`Parent branch "${parentBranch}" found in reflog but has no common ancestor with HEAD`);
          }
        } else {
          // Reflog didn't record a creation entry — fall back to main/master
          scopeLabel = 'all changes since branch base (reflog unavailable, falling back to main/master)';
          const tryBase = async (branch: string) => {
            const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', branch], {
              cwd: this.state.projectDir, timeout: 5000, maxBuffer: DEFAULT_MAX_BUFFER,
            });
            return stdout.trim();
          };
          try { baseRef = await tryBase('main'); }
          catch { try { baseRef = await tryBase('master'); }
            catch { baseRef = 'HEAD~20'; scopeLabel += ' (fallback: last 20 commits)'; } }
        }
      } else if (scope.startsWith('branch:')) {
        const branchName = scope.slice('branch:'.length);
        scopeLabel = `all changes vs branch "${branchName}"`;
        try {
          const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', branchName], {
            cwd: this.state.projectDir, timeout: 5000, maxBuffer: DEFAULT_MAX_BUFFER,
          });
          baseRef = stdout.trim();
        } catch {
          throw new Error(`Branch "${branchName}" not found or has no common ancestor with HEAD`);
        }
      } else {
        const n = parseInt(scope, 10);
        if (isNaN(n) || n < 1) throw new Error(`Unknown scope "${scope}". Use: uncommitted, a number, all, or branch <name>`);
        baseRef = `HEAD~${n}`;
        scopeLabel = `last ${n} commit${n === 1 ? '' : 's'}`;
      }

      const [diffResult, namesResult] = await Promise.all([
        execFileAsync('git', ['diff', baseRef], {
          cwd: this.state.projectDir, timeout: 15_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
        execFileAsync('git', ['diff', '--name-only', baseRef], {
          cwd: this.state.projectDir, timeout: 15_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
      ]);
      diff = diffResult.stdout;
      changedFiles = namesResult.stdout.trim().split('\n').filter(Boolean);
    } catch (err) {
      this.chatMessage?.(`❌ **Review** failed to retrieve diff: ${(err as Error).message}`, 'tdd-reviewer');
      return;
    }

    if (!diff.trim()) {
      this.chatMessage?.(`ℹ️ **Review** — no changes found for scope: ${scopeLabel}`, 'tdd-reviewer');
      return;
    }

    this.chatMessage?.(`🔍 **Review** — reviewing ${scopeLabel} (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'})…`, 'tdd-reviewer');

    // ── 2. Build prompt ────────────────────────────────────────────────────
    const contextSection = context
      ? `\n\n## Context\n${context}`
      : '';

    let lensSection = '';
    try {
      const lensNow = await runLensAnalysis(this.state.projectDir);
      if (lensNow) lensSection = `\n\n## Lens Analysis (Current State)\n${lensNow}`;
    } catch { /* non-fatal */ }

    const diffSummary = `\n\n## Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n')}\n\n## Diff\n\`\`\`diff\n${diff.length > 8000 ? diff.substring(0, 8000) + '\n… (truncated)' : diff}\n\`\`\``;

    const reviewPrompt =
      `Standalone review of ${scopeLabel}. ` +
      `Note: this is outside the TDD cycle — quality gates have not been pre-verified.` +
      contextSection +
      lensSection +
      diffSummary;

    // ── 3. Run reviewer ────────────────────────────────────────────────────
    const reviewerSession = await createSubAgentSession({
      taskType: 'review',
      systemPrompt: REVIEWER_PROMPT,
      cwd: this.state.projectDir,
      modelRouter: this.modelRouter,
      notify: this.notifyUi,
      tools: 'review',
    });
    const reviewerHandle = this.subscribeToSession(reviewerSession, 'Review', 'tdd-reviewer');

    let reviewText = '';
    try {
      await withTimeout(
        reviewerSession.prompt(reviewPrompt),
        MAX_REVIEWER_DURATION_MS,
        `Reviewer timed out after ${MAX_REVIEWER_DURATION_MS / 60000} minutes`,
      );
      reviewText = await ensureStructuredVerdict(
        this.reviewerRetryHandle(reviewerSession, reviewerHandle),
        reviewerHandle.getTurnText(),
        'Standalone Review',
      );
    } finally {
      reviewerHandle.dispose();
      reviewerSession.dispose();
      logger.info('[EXECUTOR] Standalone reviewer disposed.');
      await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
    }

    // ── 4. Post verdict ────────────────────────────────────────────────────
    const { approved: isApproved, feedback } = parseReviewerVerdict(reviewText);

    if (isApproved) {
      this.chatMessage?.(
        `✅ **Review Approved** — ${scopeLabel}\n\n${feedback}`,
        'tdd-reviewer'
      );
    } else {
      this.chatMessage?.(
        `⚠️ **Review: concerns raised** — ${scopeLabel}\n\n${feedback}`,
        'tdd-reviewer'
      );
    }
  }

  /**
   * Capture the full work-item branch diff vs the base branch, plus the commit
   * log and any uncommitted changes. Three-dot syntax (`base...HEAD`) diffs from
   * the merge-base, so it shows every commit on the task branch regardless of how
   * the base has moved. Used to give the reviewer/arbiter the evidence to review.
   * Returns empty strings on git failure rather than throwing.
   */
  private async captureBranchDiff(
    originalBranch: string,
    taskId: string,
  ): Promise<{ diff: string; changedFiles: string[]; commitLog: string }> {
    const logger = getLogger();
    let diff = '';
    let changedFiles: string[] = [];
    let commitLog = '';
    try {
      const [diffResult, namesResult, logResult, uncommittedResult] = await Promise.all([
        execFileAsync('git', ['diff', `${originalBranch}...HEAD`], {
          cwd: this.state.projectDir, timeout: 10_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
        execFileAsync('git', ['diff', '--name-only', `${originalBranch}...HEAD`], {
          cwd: this.state.projectDir, timeout: 10_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
        execFileAsync('git', ['log', `${originalBranch}..HEAD`, '--pretty=format:%h %s'], {
          cwd: this.state.projectDir, timeout: 5_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
        execFileAsync('git', ['diff', 'HEAD'], {
          cwd: this.state.projectDir, timeout: 10_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
      ]);
      diff = diffResult.stdout;
      changedFiles = namesResult.stdout.trim().split('\n').filter(Boolean);
      commitLog = logResult.stdout.trim();

      // Append uncommitted changes. The implementer is supposed to commit before
      // DONE, but in failure modes (loop, timeout) there may still be unsaved work.
      const uncommittedDiff = uncommittedResult.stdout;
      if (uncommittedDiff.trim()) {
        diff += `\n\n# === UNCOMMITTED CHANGES ===\n${uncommittedDiff}`;
      }

      if (!diff.trim() && commitLog === '') {
        logger.warn(`[${taskId}] Captured diff is empty — WI branch has no commits and no uncommitted changes vs ${originalBranch}`);
      }
    } catch (err) {
      // Surface git failures instead of silently producing an empty diff,
      // which previously caused the reviewer to receive a blank prompt.
      logger.warn(`[${taskId}] Failed to capture branch diff vs ${originalBranch}: ${(err as Error).message}`);
    }
    return { diff, changedFiles, commitLog };
  }

  /**
   * Neutral arbiter: called when an implementer exhausts all normal attempts.
   * It reviews the final diff and reviewer feedback and decides whether to approve,
   * grant extra rounds, or escalate to the user.
   */
  private async runArbiter(
    task: Subtask,
    diff: string,
    changedFiles: string[],
    feedback: string,
    qualityGatesPassed: boolean,
    iterationHistory: IterationRecord[],
  ): Promise<{ decision: 'approve' | 'continue' | 'escalate'; rounds: number; rationale: string }> {
    const logger = getLogger();
    this.chatMessage?.(`⚖️ **[${task.id}]** All ${MAX_ATTEMPTS} attempts exhausted — calling neutral arbiter…`, 'tdd-arbiter');

    const arbiterPrompt = buildArbiterPrompt(task, diff, changedFiles, feedback, qualityGatesPassed, iterationHistory);

    const arbiterSession = await createSubAgentSession({
      taskType: 'arbitrate',
      systemPrompt: ARBITER_PROMPT,
      cwd: this.state.projectDir,
      modelRouter: this.modelRouter,
      notify: this.notifyUi,
      tools: 'none',
    });
    const arbiterHandle = this.subscribeToSession(arbiterSession, `Arbiter ${task.id}`, 'tdd-arbiter');

    let arbiterText = '';
    try {
      await withTimeout(
        this.promptUntilIdle(arbiterSession, arbiterPrompt),
        MAX_ARBITER_DURATION_MS,
        `Arbiter timed out after ${MAX_ARBITER_DURATION_MS / 60000} minutes`,
      );
      arbiterText = arbiterHandle.getTurnText();
    } catch (err) {
      logger.warn(`Arbiter session error: ${err} — defaulting to escalate`);
      return { decision: 'escalate', rounds: 0, rationale: `Arbiter failed: ${err}` };
    } finally {
      arbiterHandle.dispose();
      arbiterSession.dispose();
      await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
    }

    const { decision, rounds, rationale, parsedOk } = parseArbiterDecision(arbiterText);

    // Log the raw response when parsing fails so we can diagnose silent fallbacks
    // (e.g. model returned empty content, wrong format, or thinking-only output).
    if (!parsedOk) {
      const preview = arbiterText.length === 0
        ? '(empty response — no text emitted)'
        : arbiterText.length > 1000
          ? arbiterText.substring(0, 1000) + '… (truncated)'
          : arbiterText;
      logger.warn(`Arbiter response failed structured parse — raw text: ${preview}`);
    }

    logger.info(`Arbiter decision: ${decision} (rounds=${rounds}) — ${rationale}`);
    this.chatMessage?.(`⚖️ **[${task.id}] Arbiter:** ${decision.toUpperCase()} — ${rationale}`, 'tdd-arbiter');

    return { decision, rounds, rationale };
  }

  /**
   * Posts the arbiter's escalation to Pi chat and waits for the user to reply with
   * one of: "approve", "continue N" (1-3), or "stop".
   * Returns a structured action. Falls back to 'stop' when no waitForInput is wired.
   */
  private async handleArbiterEscalation(
    task: Subtask,
    diff: string,
    feedback: string,
    arbiterRationale: string,
  ): Promise<{ action: 'approve' | 'continue' | 'stop'; rounds: number }> {
    this.chatMessage?.(buildEscalationMessage(task, diff, feedback, arbiterRationale, MAX_ATTEMPTS));

    if (!this.waitForInput) {
      getLogger().warn(`[${task.id}] Arbiter escalation: no waitForInput handler — defaulting to stop`);
      return { action: 'stop', rounds: 0 };
    }

    const answer = await this.waitForInput(`Reply approve / continue N / stop for ${task.id}:`);
    return parseEscalationReply(answer);
  }

  private async runFinalWorkflowReview(workflowStartSha: string, baselineCoverage?: CoverageMetrics): Promise<void> {
    const logger = getLogger();
    const subtasks = this.state.getState().subtasks;

    this.chatMessage?.(`🔍 **Final Review** — reviewing all ${subtasks.length} task(s) together…`, 'tdd-reviewer');
    this.events.emit('taskProgress', { id: 'final-review', phase: 'reviewing', message: 'Running final workflow review…' });

    // Collect final coverage snapshot in parallel with the diff so the reviewer
    // can comment on any coverage regression or gaps across the whole epic.
    const [finalCoverage] = await Promise.allSettled([
      collectCoverageSnapshot(this.state.projectDir),
    ]);
    const currentCoverage = finalCoverage.status === 'fulfilled' ? finalCoverage.value : undefined;

    // Build cumulative diff from the start of the workflow to current HEAD
    let cumulativeDiff = '';
    let changedFiles: string[] = [];
    try {
      const ref = workflowStartSha || 'HEAD~1';
      const [diffResult, namesResult] = await Promise.all([
        execFileAsync('git', ['diff', ref], {
          cwd: this.state.projectDir, timeout: 10_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
        execFileAsync('git', ['diff', '--name-only', ref], {
          cwd: this.state.projectDir, timeout: 10_000, maxBuffer: DEFAULT_MAX_BUFFER,
        }),
      ]);
      cumulativeDiff = diffResult.stdout;
      changedFiles = namesResult.stdout.trim().split('\n').filter(Boolean);
    } catch { /* non-fatal */ }

    // Collect implementation notes from the last subtask's implementer
    let implementerNotes = '';
    try {
      const notesPath = path.join(this.state.projectDir, '.tdd-workflow', 'implementation-notes.md');
      if (fs.existsSync(notesPath)) implementerNotes = fs.readFileSync(notesPath, 'utf-8').trim();
    } catch { /* non-fatal */ }

    // Format coverage comparison for the reviewer
    let coverageSummary = '';
    if (baselineCoverage || currentCoverage) {
      const fmt = (m: CoverageMetrics) =>
        `lines=${m.lines}% functions=${m.functions}% branches=${m.branches}%`;
      if (baselineCoverage && currentCoverage) {
        const delta = (a: number, b: number) => {
          const d = Math.round((b - a) * 10) / 10;
          return d > 0 ? `+${d}` : `${d}`;
        };
        coverageSummary =
          `\n\n## Coverage\n` +
          `- Baseline (start of epic): ${fmt(baselineCoverage)}\n` +
          `- Current (end of epic):    ${fmt(currentCoverage)}\n` +
          `- Delta: lines=${delta(baselineCoverage.lines, currentCoverage.lines)}% ` +
          `functions=${delta(baselineCoverage.functions, currentCoverage.functions)}% ` +
          `branches=${delta(baselineCoverage.branches, currentCoverage.branches)}%\n\n` +
          `Flag any significant coverage drops (>2%) as a concern in your FEEDBACK.`;
      } else if (currentCoverage) {
        coverageSummary = `\n\n## Coverage (end of epic)\n${fmt(currentCoverage)}\n\nFlag any areas with notably low coverage in your FEEDBACK.`;
      }
    }

    const subtaskSummary = subtasks.map(t => `- **${t.id}**: ${t.description}`).join('\n');
    const notesSummary = implementerNotes ? `\n\n## Implementer Notes (last task)\n${implementerNotes}` : '';
    const diffSummary = changedFiles.length > 0
      ? `\n\n## Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n')}\n\n## Cumulative Diff\n\`\`\`diff\n${cumulativeDiff.length > 8000 ? cumulativeDiff.substring(0, 8000) + '\n… (truncated)' : cumulativeDiff}\n\`\`\``
      : '';

    const reviewerSession = await createSubAgentSession({
      taskType: 'review',
      systemPrompt: REVIEWER_PROMPT,
      cwd: this.state.projectDir,
      modelRouter: this.modelRouter,
      notify: this.notifyUi,
      tools: 'review',
    });
    const reviewerHandle = this.subscribeToSession(reviewerSession, 'Final Review', 'tdd-reviewer');

    let reviewText = '';
    try {
      await withTimeout(
        reviewerSession.prompt(
          `Review the complete workflow.\n\n## Tasks Completed\n${subtaskSummary}${notesSummary}${coverageSummary}${diffSummary}`
        ),
        MAX_REVIEWER_DURATION_MS,
        `Final reviewer timed out after ${MAX_REVIEWER_DURATION_MS / 60000} minutes`,
      );
      // Format reminder if the structured verdict is missing. The final review
      // uses a looser predicate (APPROVED: present) than the per-task review —
      // it is advisory, so usable feedback is not strictly required.
      reviewText = await ensureStructuredVerdict(
        this.reviewerRetryHandle(reviewerSession, reviewerHandle),
        reviewerHandle.getTurnText(),
        'Final Review',
        (text) => text.includes('APPROVED:'),
      );
    } finally {
      reviewerHandle.dispose();
      reviewerSession.dispose();
      logger.info('[EXECUTOR] Final reviewer disposed. Cooldown for slot recovery...');
      await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
    }

    // Collect any questions the reviewer wrote
    await this.collectAgentQuestions('Final Reviewer');

    const { approved: isApproved, feedback: reviewerFeedback } = parseReviewerVerdict(reviewText);

    if (isApproved) {
      logger.info('Final workflow review: approved');
      this.chatMessage?.(`✅ **Final Review Approved** — ${subtasks.length} task(s) completed and reviewed.\n\n${reviewerFeedback}`, 'tdd-reviewer');
      this.events.emit('workflowCompleted', { subtasks, reviewerFeedback });
    } else {
      logger.warn(`Final workflow review: rejected — ${reviewerFeedback.substring(0, 200)}`);
      // Advisory only — all quality gates passed and changes are merged
      this.chatMessage?.(
        `⚠️ **Final Review: concerns raised** — all quality gates passed but the reviewer has feedback:\n\n${reviewerFeedback}\n\n` +
        `All changes have been merged. Use \`/tdd\` with the specific feedback to address reviewer concerns.`,
        'tdd-reviewer'
      );
      this.events.emit('workflowReviewWarning', { subtasks, reviewerFeedback });
    }
  }

  /**
   * Run one lesson-extraction LLM call over a bounded feedback text and return
   * parsed candidates. Fail-soft: any error returns [].
   */
  private async runLessonExtraction(feedbackText: string): Promise<LessonCandidate[]> {
    const logger = getLogger();
    let session: AgentSession | null = null;
    let handle: { getTurnText(): string; dispose(): void } | null = null;
    try {
      session = await createSubAgentSession({
        taskType: 'arbitrate',
        systemPrompt: LESSON_EXTRACTOR_PROMPT,
        cwd: this.state.projectDir,
        modelRouter: this.modelRouter,
        notify: this.notifyUi,
        tools: 'none',
      });
      handle = this.subscribeToSession(session, 'Lesson Extractor', 'tdd-orchestrator');
      await withTimeout(
        this.promptUntilIdle(session, feedbackText),
        LESSON_EXTRACTION_TIMEOUT_MS,
        `Lesson extraction timed out after ${LESSON_EXTRACTION_TIMEOUT_MS / 60000} minutes`,
      );
      return parseLessonCandidates(handle.getTurnText());
    } catch (err) {
      logger.warn(`[Lessons] Extraction failed: ${err}`);
      return [];
    } finally {
      try { handle?.dispose(); } catch { /* best-effort */ }
      try { session?.dispose(); } catch { /* best-effort */ }
      await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
    }
  }

  /** Distill one finished task's feedback rounds into the lesson store. */
  private async extractLessonsFromTask(taskId: string, feedbackHistory: FeedbackRound[]): Promise<void> {
    const logger = getLogger();
    try {
      const input = boundFeedbackForPrompt(
        feedbackHistory
          .map(h => `## Round ${h.round} (${h.type === 'gates' ? 'Quality Gates' : 'Code Review'})\n${h.text.slice(0, 2000)}`)
          .join('\n\n'),
        12_000,
      );
      const candidates = await this.runLessonExtraction(input);
      if (candidates.length === 0) return;

      const store = LessonStore.load(this.state.projectDir);
      const { added, reinforced } = store.mergeCandidates(candidates, taskId);
      store.save();
      logger.info(`[Lessons] ${taskId}: ${candidates.length} candidate(s) → ${added} new, ${reinforced} reinforced (${store.count()} total)`);
      if (added > 0 || reinforced > 0) {
        this.chatMessage?.(
          `🧠 **[${taskId}]** Learned from this task's feedback: ${added} new lesson(s), ${reinforced} reinforced. ` +
          `Lessons seen in 2+ tasks are injected into future implementer prompts (\`/tdd:lessons\` to view).`,
          'tdd-orchestrator',
        );
      }
    } catch (err) {
      logger.warn(`[Lessons] extractLessonsFromTask failed for ${taskId}: ${err}`);
    }
  }

  /**
   * Retroactively learn from all feedback-history files on disk
   * (.tdd-workflow/logs/feedback-history-*.md). Idempotent w.r.t. occurrence
   * counts: a lesson is only reinforced once per source task, so re-running
   * does not inflate counts. Used by /tdd:lessons learn.
   */
  public async learnFromFeedbackHistories(maxFiles = 30): Promise<{ files: number; added: number; reinforced: number; total: number }> {
    const logger = getLogger();
    const logsDir = path.join(this.state.projectDir, '.tdd-workflow', 'logs');
    let files: string[] = [];
    try {
      files = fs.readdirSync(logsDir).filter(f => /^feedback-history-.+\.md$/.test(f));
    } catch {
      return { files: 0, added: 0, reinforced: 0, total: 0 };
    }
    files.sort((a, b) =>
      fs.statSync(path.join(logsDir, b)).mtimeMs - fs.statSync(path.join(logsDir, a)).mtimeMs);
    files = files.slice(0, maxFiles);

    const store = LessonStore.load(this.state.projectDir);
    let added = 0;
    let reinforced = 0;
    let processed = 0;

    for (const file of files) {
      const taskId = file.replace(/^feedback-history-/, '').replace(/\.md$/, '');
      let raw = '';
      try {
        raw = fs.readFileSync(path.join(logsDir, file), 'utf-8');
      } catch { continue; }
      if (!raw.trim()) continue;

      const candidates = await this.runLessonExtraction(boundFeedbackForPrompt(raw, 12_000));
      const result = store.mergeCandidates(candidates, taskId);
      added += result.added;
      reinforced += result.reinforced;
      processed++;
      logger.info(`[Lessons] learn ${taskId}: ${candidates.length} candidate(s), +${result.added} new, ${result.reinforced} reinforced`);
      this.chatMessage?.(
        `🧠 ${taskId}: ${candidates.length} candidate(s) → +${result.added} new, ${result.reinforced} reinforced`,
        'tdd-orchestrator',
      );
    }

    store.save();
    return { files: processed, added, reinforced, total: store.count() };
  }

  public async refineTaskIntoSubtasks(taskId: string, attempt: number): Promise<string> {
    const logger = getLogger();
    const task = this.state.getSubtask(taskId);
    if (!task) return '';

    // Only refine on the first attempt — retries reuse the same technical plan
    // but with updated feedback injected via the system prompt.
    if (attempt > 1) return task.description;

    logger.info(`Sub-refining task ${task.id} for TDD granularity...`);
    const subPlan = await planAndBreakdown(
      `Implement this specific work item: ${task.description}\n\n` +
      `Existing architectural context:\n${this.state.getState().refined_request}\n\n` +
      `IMPORTANT: Break this down into high-granularity technical tasks. Each task should ideally add or modify 1 or 2 methods. ` +
      `This granularity ensures quality in small models.`,
      this.modelRouter,
      this.searchClient || undefined
    );

    if (subPlan.subtasks.length === 0) {
      logger.warn(`Refinement returned 0 subtasks for ${task.id} — using original description`);
      return task.description;
    }

    const plan = subPlan.subtasks.map((s, i) => `${i + 1}. ${s.description}`).join('\n');
    logger.info(`Task ${task.id} refined into ${subPlan.subtasks.length} steps`);

    // Only post the refinement summary when the planner actually decomposed the task into
    // multiple steps. A single-step result is effectively a pass-through — posting it would
    // just duplicate the checklist entry the user already saw.
    if (subPlan.subtasks.length > 1) {
      this.chatMessage?.(
        `🔍 **${task.id}** refined into ${subPlan.subtasks.length} implementation steps:\n${plan}`
      );
    }

    return `Task: ${task.description}\n\nTechnical Plan:\n${plan}`;
  }

}

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { createHash } from 'crypto';
import { StateManager, WorkflowState, Subtask } from './state.js';
import * as path from 'path';
import { Sandbox } from './sandbox.js';
import { runQualityGates, runLensAnalysis, diffGateFailures } from './quality-gates.js';
import { ModelRouter } from '../llm/model-router.js';
import { SearchClient } from '../search/searxng.js';
import { planAndBreakdown } from '../agents/planner.js';
import { EpicLoader, EpicPlan } from './epic-loader.js';
import { createSubAgentSession, type SubAgentOptions } from '../subagent/factory.js';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { IMPLEMENTER_PROMPT, REVIEWER_PROMPT, ARBITER_PROMPT } from '../subagent/prompts.js';
import { getLogger } from '../utils/logger.js';
import { execFileAsync, DEFAULT_MAX_BUFFER, sanitizeBranchName } from '../utils/exec.js';
import { getTestCommand, detectPackageManager } from './test-runner.js';

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
const MAX_ARBITER_EXTRA_ROUNDS = 10;           // Max extra rounds the arbiter may grant
const MAX_IMPLEMENTER_DURATION_MS = 60 * 60 * 1000;  // 60 minutes for the implementer
const MAX_REVIEWER_DURATION_MS    = 60 * 60 * 1000;  // 60 minutes for the reviewer
const MAX_ARBITER_DURATION_MS     = 20 * 60 * 1000;  // 20 minutes for the arbiter
const MAX_CONSECUTIVE_FAILURES = 3;            // Circuit breaker for the whole workflow
const SIMILARITY_THRESHOLD = 0.9;              // If outputs are >90% similar, it's a loop
/** Delay after sub-agent session disposal to allow slot reclaim. Override with TDD_SLOT_RECOVERY_MS env var. */
const SLOT_RECOVERY_DELAY_MS = parseInt(process.env['TDD_SLOT_RECOVERY_MS'] ?? '5000', 10);

/**
 * Detect if two strings are suspiciously similar (agent is looping).
 * Uses a simple character-level comparison — fast and good enough for code output.
 */
/**
 * Race a promise against a timeout, but always clear the timer when either side
 * settles so we don't leak a Node.js timer for up to an hour.
 * Plain `Promise.race([p, setTimeoutReject(ms)])` leaves the timer armed, which
 * matters for long timeouts (the process can't exit cleanly and the captured
 * closure stays in memory).
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  private subscribeToSession(
    session: any,
    label: string,
    messageType: string,
  ): { getTurnText(): string; resetTurnText(): void; dispose(): void } {
    const chatMessage = this.chatMessage;
    const CHUNK_SIZE = 800;
    let thinkingBuffer = '';
    let turnText = '';
    let disposed = false;

    session.subscribe((event: any) => {
      if (disposed) return;

      if (event.type === 'message_update') {
        const ae = event.assistantMessageEvent;
        if (ae?.type === 'thinking_start') {
          thinkingBuffer = '';
          chatMessage?.(`**[${label}]** 💭 _Thinking…_`, messageType);
        } else if (ae?.type === 'thinking_delta' && ae.delta) {
          thinkingBuffer += ae.delta;
          while (thinkingBuffer.length >= CHUNK_SIZE) {
            chatMessage?.(`**[${label}]** 💭 ${thinkingBuffer.substring(0, CHUNK_SIZE)}`, messageType);
            thinkingBuffer = thinkingBuffer.substring(CHUNK_SIZE);
          }
        } else if (ae?.type === 'thinking_end') {
          if (thinkingBuffer.trim()) {
            chatMessage?.(`**[${label}]** 💭 ${thinkingBuffer}`, messageType);
            thinkingBuffer = '';
          }
        } else if (ae?.type === 'text_end' && ae.content?.trim()) {
          // Accumulate for the caller (e.g. DONE:/APPROVED: detection).
          turnText += ae.content;
          chatMessage?.(`**[${label}]** ${ae.content}`, messageType);
        }
      } else if (event.type === 'message_end'
                 && event.message?.role === 'assistant'
                 && !turnText) {
        // Fallback for non-streaming / non-reasoning sessions that never
        // emit text_end but do publish the final content array.
        const text = event.message.content?.find((c: any) => c.type === 'text')?.text;
        if (text) turnText += text;
      } else if (event.type === 'tool_execution_start') {
        if (!chatMessage) return;
        const toolName: string = event.toolName;
        const args = (event.args && typeof event.args === 'object') ? event.args as Record<string, unknown> : {};
        let msg = `**[${label}]** 🔧 \`${toolName}\``;

        if (toolName === 'write') {
          const filePath = (args['path'] ?? args['file_path'] ?? '') as string;
          const content = (args['content'] ?? '') as string;
          msg += `: ${filePath}`;
          if (content) {
            const preview = content.length > 400 ? content.substring(0, 400) + '\n…' : content;
            msg += `\n\`\`\`\n${preview}\n\`\`\``;
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
            msg += `\n\`\`\`diff\n- ${oldPreview.replace(/\n/g, '\n- ')}\n+ ${newPreview.replace(/\n/g, '\n+ ')}\n\`\`\``;
          }
          if (edits.length > 2) msg += `\n_…and ${edits.length - 2} more edit(s)_`;
        } else {
          const firstArg = Object.values(args).find(v => typeof v === 'string') as string | undefined;
          if (firstArg) msg += `: ${firstArg.length > 60 ? firstArg.substring(0, 60) + '…' : firstArg}`;
        }

        chatMessage(msg, messageType);
      }
    });

    return {
      getTurnText: () => turnText,
      resetTurnText: () => { turnText = ''; },
      dispose: () => { disposed = true; },
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

    if (mode === 'retry') {
      this.resumeMode = false;
      const resetFailed = this.state.resetFailedTasks();
      logger.info(`Retry mode: reset ${resetFailed} failed tasks (feedback cleared)`);
    } else if (mode === 'resume') {
      this.resumeMode = true;
      const resumed = this.state.resumeFailedTasks();
      logger.info(`Resume mode: reset ${resumed} failed tasks (feedback preserved, branch kept)`);
    } else {
      this.resumeMode = false;
    }

    await this.processQueue();
  }

  /**
   * Run (or retry) a single task by ID without touching any other tasks.
   * The task must already exist in the workflow state (i.e. the epic must have
   * been started at least once so its subtasks were planned and saved).
   * If the task is 'failed' or 'completed', it is reset to 'pending' first.
   */
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

    // Capture each blocking gate's full output at baseline so we can compare
    // against it per-attempt. We don't just mask "was this gate failing?" —
    // we extract an error-signature set from each failing gate and only treat
    // errors that appear in the current run but NOT in the baseline as genuine
    // regressions. Otherwise a baseline of "3 tsc errors" would silently mask
    // an implementer that adds 7 more tsc errors.
    const baselineGateOutputs = new Map<string, string>();
    try {
      const baseline = await runQualityGates(this.state.projectDir);
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
    } catch (err) {
      logger.warn(`Could not capture quality gate baseline: ${err}`);
    }

    while (true) {
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(`Circuit breaker: ${consecutiveFailures} consecutive task failures.`);
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
      let approved = false;
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
      let lastAttemptBlockedByPreexisting = false;
      let lastQualityGatesPassed = false; // tracks whether the latest committed state passed QA
      const startAttempt = task.attempts || 1;
      // Implementer session is kept alive across reviewer-rejection retries so the agent
      // can continue patching its own work in a multi-turn conversation.
      // It is nulled out (and disposed) only when a runtime error forces a rollback.
      let implementerSession: AgentSession | null = null;
      // The stream handle is paired with the session lifetime — one subscription for the
      // whole lifetime of the session, with a per-turn text accumulator that we reset
      // before each prompt() call. This avoids the multi-subscribe bug where text
      // accumulated across turns and duplicated chat output.
      let implementerHandle: { getTurnText(): string; resetTurnText(): void; dispose(): void } | null = null;

      // Fast-path: if resuming from a task that was already approved and just needs merging, skip all loops.
      if (task.phase !== 'merging') {
        // Two-pass outer loop: pass 0 = normal attempts, pass 1 = arbiter-granted extra rounds.
        let arbiterExtraRounds = 0;
        for (let pass = 0; pass <= 1 && !approved; pass++) {
          if (pass === 1 && arbiterExtraRounds === 0) break;

          const attemptStart = pass === 0 ? startAttempt : MAX_ATTEMPTS + 1;
          const attemptEnd   = pass === 0 ? MAX_ATTEMPTS : MAX_ATTEMPTS + arbiterExtraRounds;

          for (let attempt = attemptStart; attempt <= attemptEnd && !approved; attempt++) {
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

            // Create the implementer session on the first attempt.
            // On reviewer-rejection retries the same session is reused (multi-turn) so
            // the agent has full context of its prior work and just applies the fixes.
            if (!implementerSession) {
              implementerSession = await createSubAgentSession({
                taskType: 'implement',
                systemPrompt: IMPLEMENTER_PROMPT,
                cwd: this.state.projectDir,
                modelRouter: this.modelRouter,
                taskMetadata: {
                  acceptance: task.acceptance,
                  security: task.security,
                  tests: task.tests,
                  devNotes: task.devNotes,
                  testCommand: getTestCommand(this.state.projectDir),
                  packageManager: detectPackageManager(this.state.projectDir),
                },
              });
              implementerHandle = this.subscribeToSession(implementerSession, `Implementer ${task.id}`, 'tdd-implementer');
            }
            const handle = implementerHandle!;

            // Build the prompt for this turn.
            let implementerPrompt: string;
            if (implementerSession && feedback && attempt > 1) {
              // Retry turn: send reviewer/gate feedback as a follow-up message.
              // The branch still has the previous implementation so the agent only
              // needs to apply the requested changes.
              this.chatMessage?.(
                `🔁 **[${task.id}]** Attempt ${attempt}/${totalMax} — continuing implementer session with reviewer feedback`
              );
              implementerPrompt =
                `The reviewer rejected your implementation. Your previous code is still on this branch — ` +
                `do not start from scratch. Read the feedback below, apply only the necessary changes, ` +
                `run the tests to confirm everything passes, and commit.\n\n## Reviewer Feedback\n${feedback}`;
            } else {
              // First turn: full task description + metadata.
              implementerPrompt = technicalDescription;
              if (task.acceptance && task.acceptance.length > 0) {
                implementerPrompt += `\n\n### Acceptance Criteria\n- ${task.acceptance.join('\n- ')}`;
              }
              if (task.security) {
                implementerPrompt += `\n\n### Security Requirements\n${task.security}`;
              }
              if (task.tests && task.tests.length > 0) {
                implementerPrompt += `\n\n### Required Tests\n- ${task.tests.join('\n- ')}`;
              }
              if (task.devNotes) {
                implementerPrompt += `\n\n### Developer Implementation Notes\n${task.devNotes}`;
              }
            }

            // Run the implementer, then nudge it to keep going if it didn't signal DONE.
            // Cap nudges to avoid infinite loops on a truly stuck agent.
            // The total time budget for this attempt (initial prompt + all nudges) is
            // MAX_IMPLEMENTER_DURATION_MS as a single deadline — NOT a per-prompt timeout
            // re-armed on each nudge. Otherwise MAX_NUDGES × per-prompt timeouts could
            // compound into a 6-hour attempt.
            const MAX_NUDGES = 5;
            const attemptDeadline = Date.now() + MAX_IMPLEMENTER_DURATION_MS;
            for (let nudge = 0; nudge <= MAX_NUDGES; nudge++) {
              handle.resetTurnText();
              const remaining = attemptDeadline - Date.now();
              if (remaining <= 0) {
                throw new Error(`Implementer attempt exceeded deadline (${MAX_IMPLEMENTER_DURATION_MS / 60000} minutes)`);
              }
              await withTimeout(
                implementerSession.prompt(implementerPrompt),
                remaining,
                `Implementer timed out after ${MAX_IMPLEMENTER_DURATION_MS / 60000} minutes (across ${nudge + 1} prompt(s))`,
              );

              if (/^DONE:/im.test(handle.getTurnText())) break;

              if (nudge < MAX_NUDGES) {
                logger.info(`[${task.id}] Implementer did not signal DONE — nudging (${nudge + 1}/${MAX_NUDGES})`);
                this.chatMessage?.(`⏩ **[${task.id}]** Implementer hasn't finished — nudging to continue (${nudge + 1}/${MAX_NUDGES})`, 'tdd-implementer');
                implementerPrompt = 'You have not signalled DONE yet. Continue implementing — write the remaining files, run the tests, commit, then end your message with `DONE: <summary>`.';
              } else {
                logger.warn(`[${task.id}] Implementer never signalled DONE after ${MAX_NUDGES} nudges — proceeding to quality gates anyway`);
              }
            }

            // Collect any questions the implementer wrote (outside the timeout — user
            // interaction time doesn't count against the agent's session budget).
            const implementerAnswers = await this.collectAgentQuestions(`Implementer ${task.id}`);
            if (implementerAnswers) {
              feedback = feedback ? `${feedback}\n\n${implementerAnswers}` : implementerAnswers;
            }

            // Capture diff for loop detection and reviewer context
            currentDiff = '';
            try {
              const [diffResult, namesResult] = await Promise.all([
                execFileAsync('git', ['diff', 'HEAD'], {
                  cwd: this.state.projectDir,
                  timeout: 10_000,
                  maxBuffer: DEFAULT_MAX_BUFFER,
                }),
                execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
                  cwd: this.state.projectDir,
                  timeout: 10_000,
                  maxBuffer: DEFAULT_MAX_BUFFER,
                }),
              ]);
              currentDiff = diffResult.stdout;
              changedFiles = namesResult.stdout.trim().split('\n').filter(Boolean);
            } catch {
              // Non-fatal — skip loop detection / pre-existing check if diff fails
            }

            if (lastAttemptDiff && currentDiff && !lastAttemptBlockedByPreexisting) {
              const similarity = outputSimilarity(lastAttemptDiff, currentDiff);
              if (similarity > SIMILARITY_THRESHOLD) {
                logger.warn(`Loop detected: attempt ${attempt} output is ${(similarity * 100).toFixed(0)}% similar to previous attempt. Bailing early.`);
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
              // For each failing blocking gate, compare against the baseline. If every
              // error in the current output was already present at baseline, the gate
              // is pre-existing and we ignore it. Otherwise build a feedback report
              // containing only the NEW errors — not the full failure dump — so the
              // implementer isn't distracted by legacy issues it wasn't asked to fix.
              const regressionReports: string[] = [];
              const regressionGates: typeof qualityReport.gates = [];
              const preexistingGates: string[] = [];

              for (const g of qualityReport.gates) {
                if (!g.blocking || g.passed) continue;
                const baseline = baselineGateOutputs.get(g.gate);
                if (baseline === undefined) {
                  // No baseline for this gate — it was green before, now red. Full regression.
                  regressionGates.push(g);
                  regressionReports.push(`[${g.gate.toUpperCase()} BLOCKING]\n${g.output}`);
                  continue;
                }
                const { newErrors, baselineCount, currentCount } = diffGateFailures(g.gate, baseline, g.output);
                if (newErrors.length === 0) {
                  preexistingGates.push(`${g.gate}(${currentCount} pre-existing)`);
                  continue;
                }
                regressionGates.push(g);
                regressionReports.push(
                  `[${g.gate.toUpperCase()} BLOCKING] ${newErrors.length} new error(s) introduced ` +
                  `(baseline had ${baselineCount}, now ${currentCount}):\n` +
                  newErrors.map(e => `  • ${e}`).join('\n')
                );
              }

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
            });

            this.events.emit('taskProgress', {
              id: task.id,
              attempt,
              phase: 'quality-gates',
              message: `✅ Quality gates passed! ${coverageInfo}`
            });
          }

          // Phase 4: Reviewing — runs for every task before merge
          {
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

              // Build reviewer prompt: notes first (context), then diff (evidence)
              const notesSummary = implementerNotes
                ? `\n\n## Implementer Notes\n${implementerNotes}`
                : '';
              const diffSummary = changedFiles.length > 0
                ? `\n\n## Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n')}\n\n## Diff\n\`\`\`diff\n${currentDiff.length > 8000 ? currentDiff.substring(0, 8000) + '\n… (truncated)' : currentDiff}\n\`\`\``
                : '';

              // Capture lens state after implementation and include before/after for the reviewer.
              // The reviewer uses this to judge whether new structural/type issues were introduced.
              let lensSection = '';
              try {
                const lensAfter = await runLensAnalysis(this.state.projectDir);
                const beforeText = lensBaseline || 'No issues';
                const afterText = lensAfter || 'No issues';
                lensSection = `\n\n## Lens Analysis (Structural & Type Checks)\n**Before this task:**\n${beforeText}\n\n**After this task:**\n${afterText}`;
              } catch { /* non-fatal — omit lens section */ }

              await withTimeout(
                reviewerSession.prompt(`Review the implementation for task: ${task.description}${notesSummary}${lensSection}${diffSummary}`),
                MAX_REVIEWER_DURATION_MS,
                `Reviewer timed out after ${MAX_REVIEWER_DURATION_MS / 60000} minutes`,
              );
              reviewText = reviewerHandle.getTurnText();

              // If the reviewer analysed but didn't produce the required verdict format,
              // send a follow-up asking it to emit only the structured lines.
              // Use a generous timeout — thinking models need several minutes even for short replies.
              const FORMAT_RETRY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
              if (!reviewText.includes('APPROVED:')) {
                logger.warn(`[${task.id}] Reviewer missing structured verdict — sending format reminder`);
                const savedReviewText = reviewText;
                reviewerHandle.resetTurnText();
                try {
                  await withTimeout(
                    reviewerSession.prompt(
                      'STOP all tool calls. Do NOT read any more files.\n\n' +
                      'Your review is complete but is missing the required structured verdict. ' +
                      'Output ONLY these three lines right now — nothing else:\n\n' +
                      'APPROVED: true/false\n' +
                      'SCORES: test_coverage=X integration=X error_handling=X security=X (1-5)\n' +
                      'FEEDBACK: <your feedback based on what you have already read>'
                    ),
                    FORMAT_RETRY_TIMEOUT_MS,
                    'format-retry-timeout',
                  );
                  reviewText = reviewerHandle.getTurnText();
                } catch {
                  reviewText = savedReviewText; // retry failed — restore original
                }
                if (!reviewText.includes('APPROVED:')) {
                  reviewText = savedReviewText; // retry still unstructured — restore
                }
              }
            } finally {
              reviewerHandle.dispose();
              reviewerSession.dispose();
              logger.info('[EXECUTOR] Reviewer disposed. Cooldown for slot recovery...');
              await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
            }

            // Collect any questions the reviewer wrote (outside the timeout)
            const reviewerAnswers = await this.collectAgentQuestions(`Reviewer ${task.id}`);

            // Parse Reviewer Verdict
            const isApproved = /APPROVED:\s*true/i.test(reviewText);
            const feedbackMatch = reviewText.match(/FEEDBACK:\s*([\s\S]*)$/i);
            // Only use the FEEDBACK: section as feedback — not the full review analysis.
            // If the reviewer didn't follow the format, treat the whole session as a rejection
            // with a clear message rather than dumping confusing analysis text into the implementer's prompt.
            const reviewerFeedback = (feedbackMatch?.[1]?.trim())
              || (reviewText.trim() ? `Reviewer rejected but did not follow the structured output format. Full review:\n${reviewText.substring(0, 600)}` : 'Reviewer session produced no output — possible timeout or crash.');

            if (!isApproved) {
              logger.info(`Review rejected: ${reviewerFeedback.substring(0, 200)}`);
              feedback = reviewerAnswers
                ? `${reviewerFeedback}\n\n${reviewerAnswers}`
                : reviewerFeedback;

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
          logger.error(`Attempt ${attempt} error: ${err}`);
          feedback = `Runtime error: ${err}`;
          // Dispose the implementer session on error — the branch will be rolled back
          // so the session's in-flight context is no longer valid.
          if (implementerSession) {
            try { implementerHandle?.dispose(); } catch { }
            try { implementerSession.dispose(); } catch { }
            implementerHandle = null;
            implementerSession = null;
            logger.info('[EXECUTOR] Implementer session disposed after error.');
            await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
          }
          try { await this.sandbox.rollback(originalBranch); } catch { }
        }
          } // end inner attempt for-loop

          // Between pass 0 and pass 1: run the arbiter to decide what happens next.
          if (pass === 0 && !approved) {
            const arbiterDecision = await this.runArbiter(task, currentDiff, changedFiles, feedback, lastQualityGatesPassed);
            if (arbiterDecision.decision === 'approve') {
              if (lastQualityGatesPassed) {
                approved = true; // fall through to Phase 5 merge
              } else {
                // Can't approve if QA never passed — treat as escalation
                this.chatMessage?.(`⚖️ **[${task.id}]** Arbiter wanted to approve but quality gates never passed — escalating to you.`, 'tdd-arbiter');
                const userDecision = await this.handleArbiterEscalation(task, currentDiff, feedback,
                  `${arbiterDecision.rationale} (QA never passed — approval blocked)`);
                if (userDecision.action === 'approve' && lastQualityGatesPassed) {
                  approved = true;
                } else if (userDecision.action === 'continue') {
                  arbiterExtraRounds = userDecision.rounds;
                }
                // else stop: leave approved=false, loop exits, task fails
              }
            } else if (arbiterDecision.decision === 'continue') {
              arbiterExtraRounds = arbiterDecision.rounds;
            } else { // escalate
              const userDecision = await this.handleArbiterEscalation(task, currentDiff, feedback, arbiterDecision.rationale);
              if (userDecision.action === 'approve' && lastQualityGatesPassed) {
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
          logger.info('[EXECUTOR] Implementer session disposed after task completion.');
          await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
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
        const completedTask = this.state.getState().subtasks.find(t => t.id === task.id);
        this.postChecklistUpdate();
        if (completedTask) {
          this.events.emit('taskCompleted', { id: task.id, task: completedTask });
        }
        approved = true; // ensure correct path below for resuming tasks
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
        this.chatMessage?.(
          `❌ **${task.id}** failed after ${MAX_ATTEMPTS} attempts: ${task.description}\n\n` +
          `**Feedback:** ${feedbackPreview}\n\n` +
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

    // Final workflow review: runs after all tasks complete, sees the full cumulative diff.
    // Per-task reviewers approved each story individually; this is an additional holistic
    // check across all changes. A rejection here is advisory — all changes are already merged.
    const allCompleted = this.state.getState().subtasks.every(t => t.status === 'completed');
    if (allCompleted && totalSubtasks > 1) {
      await this.runFinalWorkflowReview(workflowStartSha);
    }
  }

  /**
   * Run a single reviewer over the full cumulative diff after all tasks have been individually
   * reviewed and merged. Sees the coherent finished state across all tasks.
   * A rejection here is advisory — all quality gates have already passed and changes are
   * merged. The feedback is posted to chat for the user to act on.
   */
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
  ): Promise<{ decision: 'approve' | 'continue' | 'escalate'; rounds: number; rationale: string }> {
    const logger = getLogger();
    this.chatMessage?.(`⚖️ **[${task.id}]** All ${MAX_ATTEMPTS} attempts exhausted — calling neutral arbiter…`, 'tdd-arbiter');

    const diffSummary = changedFiles.length > 0
      ? `\n\n## Changed Files\n${changedFiles.map(f => `- ${f}`).join('\n')}\n\n## Diff\n\`\`\`diff\n${diff.length > 6000 ? diff.substring(0, 6000) + '\n… (truncated)' : diff}\n\`\`\``
      : '\n\n## Diff\n(no diff captured)';

    const arbiterPrompt =
      `## Task\n${task.description}\n\n` +
      `## Quality Gates\n${qualityGatesPassed ? '✅ Passed' : '❌ Failed — code has blocking quality issues'}\n\n` +
      `## Reviewer\'s Final Feedback\n${feedback || '(no feedback recorded)'}` +
      diffSummary;

    const arbiterSession = await createSubAgentSession({
      taskType: 'arbitrate',
      systemPrompt: ARBITER_PROMPT,
      cwd: this.state.projectDir,
      modelRouter: this.modelRouter,
      tools: 'none',
    });
    const arbiterHandle = this.subscribeToSession(arbiterSession, `Arbiter ${task.id}`, 'tdd-arbiter');

    let arbiterText = '';
    try {
      await withTimeout(
        arbiterSession.prompt(arbiterPrompt),
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

    const decisionMatch = arbiterText.match(/DECISION:\s*(approve|continue|escalate)/i);
    const roundsMatch   = arbiterText.match(/ROUNDS:\s*(\d+)/i);
    const rationaleMatch = arbiterText.match(/RATIONALE:\s*(.+)/i);

    const decision  = (decisionMatch?.[1]?.toLowerCase() ?? 'escalate') as 'approve' | 'continue' | 'escalate';
    const rounds    = Math.min(parseInt(roundsMatch?.[1] ?? '1', 10), MAX_ARBITER_EXTRA_ROUNDS);
    const rationale = rationaleMatch?.[1]?.trim() ?? 'Arbiter provided no rationale.';

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
    const diffPreview = diff.length > 1500 ? diff.substring(0, 1500) + '\n… (truncated)' : diff;
    const feedbackPreview = feedback.length > 400 ? feedback.substring(0, 400) + '…' : feedback;

    const msg =
      `⚖️ **Arbiter: your input needed for ${task.id}**\n\n` +
      `The task could not be resolved after ${MAX_ATTEMPTS} attempts.\n\n` +
      `**Arbiter's assessment:** ${arbiterRationale}\n\n` +
      `**Task:** ${task.description}\n\n` +
      `**Reviewer\'s final feedback:**\n${feedbackPreview}\n\n` +
      `**Diff preview:**\n\`\`\`diff\n${diffPreview}\n\`\`\`\n\n` +
      `**Your options (reply with one):**\n` +
      `- \`approve\` — accept the current implementation as-is\n` +
      `- \`continue 1\` / \`continue 2\` / \`continue 3\` — grant more rounds\n` +
      `- \`stop\` — mark as failed and move on`;

    this.chatMessage?.(msg);

    if (!this.waitForInput) {
      getLogger().warn(`[${task.id}] Arbiter escalation: no waitForInput handler — defaulting to stop`);
      return { action: 'stop', rounds: 0 };
    }

    const answer = await this.waitForInput(`Reply approve / continue N / stop for ${task.id}:`);
    if (!answer?.trim()) return { action: 'stop', rounds: 0 };

    const lower = answer.trim().toLowerCase();
    if (lower === 'approve') return { action: 'approve', rounds: 0 };
    const continueMatch = lower.match(/^continue\s+(\d+)$/);
    if (continueMatch) {
      return { action: 'continue', rounds: Math.min(parseInt(continueMatch[1]!, 10), MAX_ARBITER_EXTRA_ROUNDS) };
    }
    return { action: 'stop', rounds: 0 };
  }

  private async runFinalWorkflowReview(workflowStartSha: string): Promise<void> {
    const logger = getLogger();
    const subtasks = this.state.getState().subtasks;

    this.chatMessage?.(`🔍 **Final Review** — reviewing all ${subtasks.length} task(s) together…`, 'tdd-reviewer');
    this.events.emit('taskProgress', { id: 'final-review', phase: 'reviewing', message: 'Running final workflow review…' });

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
      tools: 'review',
    });
    const reviewerHandle = this.subscribeToSession(reviewerSession, 'Final Review', 'tdd-reviewer');

    let reviewText = '';
    try {
      await withTimeout(
        reviewerSession.prompt(
          `Review the complete workflow.\n\n## Tasks Completed\n${subtaskSummary}${notesSummary}${diffSummary}`
        ),
        MAX_REVIEWER_DURATION_MS,
        `Final reviewer timed out after ${MAX_REVIEWER_DURATION_MS / 60000} minutes`,
      );
      reviewText = reviewerHandle.getTurnText();

      // Format reminder if structured verdict is missing
      const FORMAT_RETRY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
      if (!reviewText.includes('APPROVED:')) {
        logger.warn('[EXECUTOR] Final reviewer missing structured verdict — sending format reminder');
        const savedReviewText = reviewText;
        reviewerHandle.resetTurnText();
        try {
          await withTimeout(
            reviewerSession.prompt(
              'STOP all tool calls. Do NOT read any more files.\n\n' +
              'Your review is complete but is missing the required structured verdict. ' +
              'Output ONLY these three lines right now — nothing else:\n\n' +
              'APPROVED: true/false\n' +
              'SCORES: test_coverage=X integration=X error_handling=X security=X (1-5)\n' +
              'FEEDBACK: <your feedback based on what you have already read>'
            ),
            FORMAT_RETRY_TIMEOUT_MS,
            'format-retry-timeout',
          );
          reviewText = reviewerHandle.getTurnText();
        } catch {
          reviewText = savedReviewText;
        }
        if (!reviewText.includes('APPROVED:')) reviewText = savedReviewText;
      }
    } finally {
      reviewerHandle.dispose();
      reviewerSession.dispose();
      logger.info('[EXECUTOR] Final reviewer disposed. Cooldown for slot recovery...');
      await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
    }

    // Collect any questions the reviewer wrote
    await this.collectAgentQuestions('Final Reviewer');

    const isApproved = /APPROVED:\s*true/i.test(reviewText);
    const feedbackMatch = reviewText.match(/FEEDBACK:\s*([\s\S]*)$/i);
    const reviewerFeedback = (feedbackMatch?.[1]?.trim())
      || (reviewText.trim() ? `Reviewer did not follow structured format. Full review:\n${reviewText.substring(0, 600)}` : 'Final reviewer session produced no output.');

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

import { EventEmitter } from 'events';
import { StateManager, WorkflowState, Subtask } from './state.js';
import * as path from 'path';
import { Sandbox } from './sandbox.js';
import { runQualityGates, formatGateFailures } from './quality-gates.js';
import { ModelRouter } from '../llm/model-router.js';
import { SearchClient } from '../search/searxng.js';
import { planAndBreakdown } from '../agents/planner.js';
import { EpicLoader, EpicPlan } from './epic-loader.js';
import { createSubAgentSession } from '../subagent/factory.js';
import { IMPLEMENTER_PROMPT, REVIEWER_PROMPT } from '../subagent/prompts.js';
import { getLogger } from '../utils/logger.js';
import { execFileAsync, DEFAULT_MAX_BUFFER } from '../utils/exec.js';

export interface ExecutorOptions {
  searchClient?: SearchClient | null;
  /** Optional callback to post messages into the Pi chat history. */
  chatMessage?: (content: string) => void;
}

const MAX_ATTEMPTS = 5;
const MAX_IMPLEMENTER_DURATION_MS = 60 * 60 * 1000;  // 60 minutes for the implementer
const MAX_REVIEWER_DURATION_MS    = 60 * 60 * 1000;  // 60 minutes for the reviewer
const MAX_CONSECUTIVE_FAILURES = 3;            // Circuit breaker for the whole workflow
const SIMILARITY_THRESHOLD = 0.9;              // If outputs are >90% similar, it's a loop
/** Delay after sub-agent session disposal to allow slot reclaim. Override with TDD_SLOT_RECOVERY_MS env var. */
const SLOT_RECOVERY_DELAY_MS = parseInt(process.env['TDD_SLOT_RECOVERY_MS'] ?? '5000', 10);

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

export class WorkflowExecutor {
  private state: StateManager;
  private modelRouter: ModelRouter;
  private sandbox: Sandbox;
  private searchClient: SearchClient | null;
  private chatMessage: ((content: string) => void) | null;
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
  }

  /**
   * Subscribe to a sub-agent session and stream thinking blocks, text output,
   * and tool calls into Pi chat. Mirrors the pattern in project-planner.ts.
   */
  private subscribeToSession(session: any, label: string): void {
    if (!this.chatMessage) return;
    const chatMessage = this.chatMessage;
    const CHUNK_SIZE = 800;
    let thinkingBuffer = '';

    session.subscribe((event: any) => {
      if (event.type === 'message_update') {
        const ae = event.assistantMessageEvent;
        if (ae.type === 'thinking_start') {
          thinkingBuffer = '';
          chatMessage(`**[${label}]** 💭 _Thinking…_`);
        } else if (ae.type === 'thinking_delta' && ae.delta) {
          thinkingBuffer += ae.delta;
          while (thinkingBuffer.length >= CHUNK_SIZE) {
            chatMessage(`**[${label}]** 💭 ${thinkingBuffer.substring(0, CHUNK_SIZE)}`);
            thinkingBuffer = thinkingBuffer.substring(CHUNK_SIZE);
          }
        } else if (ae.type === 'thinking_end') {
          if (thinkingBuffer.trim()) {
            chatMessage(`**[${label}]** 💭 ${thinkingBuffer}`);
            thinkingBuffer = '';
          }
        } else if (ae.type === 'text_end' && ae.content?.trim()) {
          chatMessage(`**[${label}]** ${ae.content}`);
        }
      } else if (event.type === 'tool_execution_start') {
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

        chatMessage(msg);
      }
    });
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

  async startNew(request: string): Promise<void> {
    const logger = getLogger();
    logger.info(`Starting new workflow: ${request.substring(0, 100)}`);
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

    await this.processQueue();
  }

  async resume(retryFailed = false): Promise<void> {
    const logger = getLogger();

    if (!this.state.hasWorkflow()) {
      throw new Error('No workflow state found. Start a new workflow first.');
    }

    const resetInterrupted = this.state.resetInterruptedTasks();
    if (resetInterrupted > 0) {
      logger.info(`Resume check: Found ${resetInterrupted} tasks already in progress.`);
    }

    if (retryFailed) {
      const resetFailed = this.state.resetFailedTasks();
      logger.info(`Reset ${resetFailed} failed tasks to pending`);
    }

    await this.processQueue();
  }

  private async processQueue(): Promise<void> {
    const logger = getLogger();
    let consecutiveFailures = 0;

    // Capture which blocking gates are already failing before any agent runs.
    // Post-implementer, only NEW failures (not in this baseline) are counted.
    let baselineFailingGates = new Set<string>();
    try {
      const baseline = await runQualityGates(this.state.projectDir);
      if (!baseline.allBlockingPassed) {
        baselineFailingGates = new Set(
          baseline.gates.filter(g => g.blocking && !g.passed).map(g => g.gate)
        );
        logger.info(`Baseline blocking gate failures: ${[...baselineFailingGates].join(', ')}`);
        this.chatMessage?.(
          `ℹ️ Pre-existing quality gate failures detected before any agent runs: **${[...baselineFailingGates].join(', ')}**. ` +
          `These will not block task completion.`
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

      const task = this.state.getNextPendingTask();
      if (!task) break;

      logger.info(`\n--- Task ${task.id}: ${task.description.substring(0, 80)} ---`);

      // Only emit taskStarted if we are actually starting fresh
      if (task.status !== 'in_progress') {
        this.state.updateSubtask(task.id, { status: 'in_progress' });
        this.events.emit('taskStarted', { id: task.id, description: task.description });
        this.postChecklistUpdate(task.id);
      }

      const originalBranch = await this.sandbox.getCurrentBranch();
      const branchName = `tdd-workflow/${task.id.substring(0, 12)}`;
      let approved = false;
      let feedback = '';

      let lastAttemptDiff = '';
      let changedFiles: string[] = [];
      let lastAttemptBlockedByPreexisting = false;
      const startAttempt = task.attempts || 1;
      for (let attempt = startAttempt; attempt <= MAX_ATTEMPTS && !approved; attempt++) {

        logger.info(`Attempt ${attempt}/${MAX_ATTEMPTS}`);
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
            await this.sandbox.createBranch(branchName);
            this.state.updateSubtask(task.id, { phase: 'implementing' });
            this.events.emit('taskProgress', {
              id: task.id,
              attempt,
              phase: 'implementing',
              message: feedback
                ? `Addressing feedback from previous attempt (Build -> Test -> Fix)...`
                : `Agent is building implementation (Read -> Test -> Code)...`
            });

            if (attempt > 1) {
              this.chatMessage?.(
                `🔁 **[${task.id}]** Attempt ${attempt}/${MAX_ATTEMPTS} — agent is starting with the above feedback injected into its system prompt`
              );
            }

            const implementerSession = await createSubAgentSession({
              taskType: 'implement',
              systemPrompt: IMPLEMENTER_PROMPT,
              cwd: this.state.projectDir,
              modelRouter: this.modelRouter,
              feedback: feedback || undefined,
              taskMetadata: {
                acceptance: task.acceptance,
                security: task.security,
                tests: task.tests,
                devNotes: task.devNotes,
              },
            });
            this.subscribeToSession(implementerSession, `Implementer ${task.id}`);

            // Enrich the prompt
            let implementerPrompt = technicalDescription;
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

            try {
              const implementerTimeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Implementer timed out after ${MAX_IMPLEMENTER_DURATION_MS / 60000} minutes`)), MAX_IMPLEMENTER_DURATION_MS)
              );
              await Promise.race([implementerSession.prompt(implementerPrompt), implementerTimeout]);
            } finally {
              implementerSession.dispose();
              logger.info('[EXECUTOR] Implementer disposed. Cooldown for slot recovery...');
              await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
            }

            // Capture diff for loop detection and pre-existing issue detection
            let currentDiff = '';
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
              // Filter out gates that were already failing before any agent ran (baseline).
              // Only new failures introduced by this agent's changes block the task.
              const newBlockingFailures = qualityReport.gates.filter(
                g => g.blocking && !g.passed && !baselineFailingGates.has(g.gate)
              );

              if (newBlockingFailures.length === 0) {
                // Every blocking failure is pre-existing — treat as passed.
                const preexisting = [...baselineFailingGates].join(', ');
                logger.info(`All blocking gate failures are pre-existing (${preexisting}) — treating as passed for this task.`);
                this.chatMessage?.(
                  `**[${task.id}]** ℹ️ All blocking failures (**${preexisting}**) are pre-existing — not caused by this task's changes. Proceeding.`
                );
                lastAttemptBlockedByPreexisting = true;
                // Fall through to commit / reviewer as if gates passed.
              } else {
                // There are genuine new failures. Build feedback from those only.
                feedback = formatGateFailures({
                  ...qualityReport,
                  gates: newBlockingFailures,
                  allBlockingPassed: false,
                });

                logger.info(`Quality gates failed (new failures):\n${feedback.substring(0, 300)}`);

                // Emit detailed feedback for TUI
                this.events.emit('taskProgress', {
                  id: task.id,
                  attempt,
                  phase: 'quality-gates',
                  message: `❌ Quality gates failed. Feedback sent to agent.\n${feedback}`,
                  isError: true
                });

                if (attempt < MAX_ATTEMPTS) {
                  const fbPreview = feedback.length > 500 ? feedback.substring(0, 500) + '…' : feedback;
                  this.chatMessage?.(
                    `**[${task.id}]** ❌ Quality gates failed (attempt ${attempt}/${MAX_ATTEMPTS}) — sending to agent for retry:\n\`\`\`\n${fbPreview}\n\`\`\``
                  );
                  lastAttemptBlockedByPreexisting = false;
                } else {
                  lastAttemptBlockedByPreexisting = false;
                }

                this.state.updateSubtask(task.id, { phase: undefined });
                continue;
              }
            }

            // Commit passing code
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

          // Phase 4: Reviewing
          if (!task.phase || task.phase !== 'merging') {
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
            this.subscribeToSession(reviewerSession, `Reviewer ${task.id}`);

            let reviewText = '';
            try {
              reviewerSession.subscribe((event) => {
                if (event.type === 'message_end' && event.message.role === 'assistant') {
                  reviewText = event.message.content.find(c => c.type === 'text')?.text || '';
                }
              });
              const reviewerTimeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Reviewer timed out after ${MAX_REVIEWER_DURATION_MS / 60000} minutes`)), MAX_REVIEWER_DURATION_MS)
              );
              await Promise.race([reviewerSession.prompt(`Review the implementation for task: ${task.description}`), reviewerTimeout]);
            } finally {
              reviewerSession.dispose();
              logger.info('[EXECUTOR] Reviewer disposed. Cooldown for slot recovery...');
              await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
            }

            // Parse Reviewer Verdict
            const isApproved = /APPROVED:\s*true/i.test(reviewText);
            const feedbackMatch = reviewText.match(/FEEDBACK:\s*([\s\S]*)$/i);
            const reviewerFeedback = (feedbackMatch && feedbackMatch[1]) ? feedbackMatch[1].trim() : reviewText;

            if (!isApproved) {
              logger.info(`Review rejected: ${reviewerFeedback.substring(0, 200)}`);
              feedback = reviewerFeedback;

              // Emit detailed feedback for TUI
              this.events.emit('taskProgress', {
                id: task.id,
                attempt,
                phase: 'reviewing',
                message: `❌ Review rejected. Feedback sent to agent.\n\n${feedback}`,
                isError: true
              });

              if (attempt < MAX_ATTEMPTS) {
                const fbPreview = feedback.length > 500 ? feedback.substring(0, 500) + '…' : feedback;
                this.chatMessage?.(
                  `**[${task.id}]** ❌ Review rejected (attempt ${attempt}/${MAX_ATTEMPTS}) — sending to agent for retry:\n\n${fbPreview}`
                );
              }

              this.state.updateSubtask(task.id, { phase: undefined });
              continue;
            }

            approved = true;
            this.state.updateSubtask(task.id, { phase: 'merging' });
          }

          // Phase 5: Merging
          if (approved || task.phase === 'merging') {
            this.events.emit('taskProgress', {
              id: task.id,
              attempt,
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
          }

        } catch (err) {
          logger.error(`Attempt ${attempt} error: ${err}`);
          feedback = `Runtime error: ${err}`;
          try { await this.sandbox.rollback(originalBranch); } catch { }
        }
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
          `**Next step:** \`/tdd ${epicRef} retry\` to retry failed tasks, or \`/tdd ${epicRef} continue\` to skip and proceed.`
        );

        this.events.emit('taskFailed', {
          id: task.id,
          task: failedTask,
          feedback: failureMessage,
          isCircuitBroken: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
          originalBranch
        });

        // Stop the workflow — user must explicitly resume via /tdd <epic> retry|continue
        break;
      }
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
    this.chatMessage?.(
      `🔍 **${task.id}** refined into ${subPlan.subtasks.length} implementation steps:\n${plan}`
    );
    logger.info(`Task ${task.id} refined into ${subPlan.subtasks.length} steps`);

    return `Task: ${task.description}\n\nTechnical Plan:\n${plan}`;
  }

}

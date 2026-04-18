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

const MAX_ATTEMPTS = 3;
const MAX_TASK_DURATION_MS = 10 * 60 * 1000;  // 10 minutes per subtask
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
    session.subscribe((event: any) => {
      if (event.type === 'message_update') {
        const ae = event.assistantMessageEvent;
        if (ae.type === 'thinking_end' && ae.content) {
          const preview = ae.content.length > 400
            ? ae.content.substring(0, 400) + '…'
            : ae.content;
          chatMessage(`**[${label}]** 💭 ${preview}`);
        } else if (ae.type === 'text_end' && ae.content?.trim()) {
          chatMessage(`**[${label}]** ${ae.content}`);
        }
      } else if (event.type === 'tool_execution_start') {
        const firstArg = event.args && typeof event.args === 'object'
          ? Object.values(event.args as Record<string, unknown>).find(v => typeof v === 'string') as string | undefined
          : undefined;
        const argHint = firstArg
          ? `: ${firstArg.length > 60 ? firstArg.substring(0, 60) + '…' : firstArg}`
          : '';
        chatMessage(`**[${label}]** 🔧 \`${event.toolName}\`${argHint}`);
      }
    });
  }

  async startNew(request: string): Promise<void> {
    const logger = getLogger();
    logger.info(`Starting new workflow: ${request.substring(0, 100)}`);
    this.state.initWorkflow(request);

    // 1. Check if the request refers to a pre-planned Epic
    const epicLoader = new EpicLoader(this.state.projectDir);
    const epicPath = epicLoader.findEpic(request);
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
      }

      const taskStartTime = Date.now();
      const originalBranch = await this.sandbox.getCurrentBranch();
      const branchName = `tdd-workflow/${task.id.substring(0, 12)}`;
      let approved = false;
      let feedback = '';

      let lastAttemptDiff = '';
      const startAttempt = task.attempts || 1;
      for (let attempt = startAttempt; attempt <= MAX_ATTEMPTS && !approved; attempt++) {
        const elapsed = Date.now() - taskStartTime;
        if (elapsed > MAX_TASK_DURATION_MS) { // MAX_TASK_DURATION_MS total budget per subtask
          logger.error(`Task ${task.id} timed out.`);
          feedback = `Task exceeded time budget of ${MAX_TASK_DURATION_MS / 60000} minutes`;
          break;
        }

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
              await implementerSession.prompt(implementerPrompt);
            } finally {
              implementerSession.dispose();
              logger.info('[EXECUTOR] Implementer disposed. Cooldown for slot recovery...');
              await new Promise(resolve => setTimeout(resolve, SLOT_RECOVERY_DELAY_MS));
            }

            // Capture diff for loop detection
            let currentDiff = '';
            try {
              const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
                cwd: this.state.projectDir,
                timeout: 10_000,
                maxBuffer: DEFAULT_MAX_BUFFER,
              });
              currentDiff = stdout;
            } catch {
              // Non-fatal — skip loop detection if diff fails
            }

            if (lastAttemptDiff && currentDiff) {
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
              feedback = formatGateFailures(qualityReport);
              logger.info(`Quality gates failed:\n${feedback.substring(0, 300)}`);
              
              // Emit detailed feedback for TUI
              this.events.emit('taskProgress', {
                id: task.id,
                attempt,
                phase: 'quality-gates',
                message: `❌ Quality gates failed. Feedback sent to agent.\n${feedback}`,
                isError: true
              });

              this.state.updateSubtask(task.id, { phase: undefined });
              continue;
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
              await reviewerSession.prompt(`Review the implementation for task: ${task.description}`);
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
            this.chatMessage?.(`✅ **${task.id}** completed (attempt ${attempt}): ${task.description}`);
            const completedTask = this.state.getState().subtasks.find(t => t.id === task.id);
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

        // Post failure summary to chat with inspection pointers
        const feedbackPreview = feedback.length > 300 ? feedback.substring(0, 300) + '…' : feedback;
        this.chatMessage?.(
          `❌ **${task.id}** failed after ${MAX_ATTEMPTS} attempts: ${task.description}\n\n` +
          `**Feedback:** ${feedbackPreview}\n\n` +
          `**Inspect:** branch \`${branchName}\` has the last attempt's changes\n` +
          `State: \`.tdd-workflow/state.json\` · Logs: \`.tdd-workflow/logs/\``
        );

        this.events.emit('taskFailed', {
          id: task.id,
          task: failedTask,
          feedback: failureMessage,
          isCircuitBroken: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES,
          originalBranch
        });
      }
    }
  }

  public async refineTaskIntoSubtasks(taskId: string, attempt: number): Promise<string> {
    const logger = getLogger();
    const task = this.state.getSubtask(taskId);
    if (!task) return '';
    let technicalDescription = task.description;
    if (attempt === 1 && (task.description.length < 100 || !task.description.toLowerCase().includes('test'))) {
      logger.info(`Sub-refining task ${task.id} for TDD granularity...`);
      const subPlan = await planAndBreakdown(
        `Implement this specific work item: ${task.description}\n\n` +
        `Existing architectural context:\n${this.state.getState().refined_request}\n\n` +
        `IMPORTANT: Break this down into high-granularity technical tasks. Each task should ideally add or modify 1 or 2 methods. ` +
        `This granularity ensures quality in small models.`,
        this.modelRouter,
        this.searchClient || undefined
      );
      technicalDescription = `Task: ${task.description}\n\nTechnical Plan:\n` +
        subPlan.subtasks.map((s, i) => `${i + 1}. ${s.description}`).join('\n');
    }
    return technicalDescription;
  }

}

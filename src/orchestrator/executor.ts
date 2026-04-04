import { EventEmitter } from 'events';
import { StateManager } from './state.js';
import { Sandbox } from './sandbox.js';
import { runQualityGates, formatGateFailures } from './quality-gates.js';
import { LLMClient } from '../llm/client.js';
import { SearchClient } from '../search/searxng.js';
import { gatherWorkspaceSnapshot } from '../context/gatherer.js';
import { planAndBreakdown } from '../agents/planner.js';
import { implementSubtask } from '../agents/implementer.js';
import { reviewImplementation } from '../agents/reviewer.js';
import { getLogger } from '../utils/logger.js';
import { MCPClientPool } from '../mcp/client-pool.js';

export interface ExecutorOptions {
  searchClient?: SearchClient | null;
  mcpPool?: MCPClientPool | null;
}

const MAX_ATTEMPTS = 3;
const MAX_TASK_DURATION_MS = 10 * 60 * 1000;  // 10 minutes per subtask
const MAX_CONSECUTIVE_FAILURES = 3;            // Circuit breaker for the whole workflow
const SIMILARITY_THRESHOLD = 0.9;              // If outputs are >90% similar, it's a loop

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
  private llm: LLMClient;
  private sandbox: Sandbox;
  private searchClient: SearchClient | null;
  private mcpPool: MCPClientPool | null;
  public events = new EventEmitter();

  constructor(
    state: StateManager,
    llm: LLMClient,
    options?: ExecutorOptions
  ) {
    this.state = state;
    this.llm = llm;
    this.sandbox = new Sandbox(state.projectDir);
    this.searchClient = options?.searchClient || null;
    this.mcpPool = options?.mcpPool || null;
  }

  async startNew(request: string): Promise<void> {
    const logger = getLogger();
    logger.info(`Starting new workflow: ${request.substring(0, 100)}`);
    this.state.initWorkflow(request);

    const plan = await planAndBreakdown(request, this.llm, this.searchClient || undefined);
    this.state.updateRefinedRequest(plan.refinedRequest);
    this.state.setSubtasks(plan.subtasks);

    await this.processQueue();
  }

  async resume(retryFailed = false): Promise<void> {
    const logger = getLogger();

    if (!this.state.hasWorkflow()) {
      throw new Error('No workflow state found. Start a new workflow first.');
    }

    const resetInterrupted = this.state.resetInterruptedTasks();
    if (resetInterrupted > 0) {
      logger.info(`Reset ${resetInterrupted} interrupted tasks to pending`);
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
      // Circuit breaker: stop if too many tasks fail in a row
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error(
          `Circuit breaker: ${consecutiveFailures} consecutive task failures. ` +
          `Stopping workflow to prevent wasted compute. Resume with retryFailed=true to try again.`
        );
        break;
      }

      const task = this.state.getNextPendingTask();
      if (!task) {
        const summary = this.state.getSummary();
        logger.info(
          `Queue empty. Total: ${summary.total} Completed: ${summary.completed} Failed: ${summary.failed}`
        );
        break;
      }

      logger.info(`\n--- Task ${task.id}: ${task.description.substring(0, 80)} ---`);
      this.state.updateSubtask(task.id, { status: 'in_progress' });
      this.events.emit('taskStarted', { id: task.id, description: task.description });

      const taskStartTime = Date.now();
      const originalBranch = await this.sandbox.getCurrentBranch();
      const branchName = `tdd-workflow/${task.id.substring(0, 8)}`;
      let approved = false;
      let feedback = '';
      let lastOutput = '';  // For loop detection

      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !approved; attempt++) {
        // Time budget check
        const elapsed = Date.now() - taskStartTime;
        if (elapsed > MAX_TASK_DURATION_MS) {
          logger.error(`Task ${task.id} exceeded time budget (${Math.round(elapsed / 1000)}s). Bailing out.`);
          feedback = `Task exceeded time budget of ${MAX_TASK_DURATION_MS / 1000}s`;
          break;
        }

        logger.info(`Attempt ${attempt}/${MAX_ATTEMPTS}`);
        this.state.updateSubtask(task.id, { attempts: attempt });

        try {
          // 1. Gather fresh workspace context
          const snapshot = await gatherWorkspaceSnapshot(
            this.state.projectDir, 
            task.description,
            this.mcpPool || undefined
          );

          // 2. Create sandbox branch
          await this.sandbox.createBranch(branchName);

          // 3. Implement
          this.events.emit('taskProgress', { 
            id: task.id, 
            attempt, 
            phase: 'implementing',
            message: 'Writing tests and code...'
          });
          const implementation = await implementSubtask(task.description, snapshot, this.llm, {
            feedbackContext: feedback || undefined,
            attempt,
            searchClient: this.searchClient || undefined,
          });

          // 4. Loop detection — check if output is suspiciously similar to last attempt
          const currentOutput = JSON.stringify(implementation);
          if (attempt > 1 && lastOutput) {
            const similarity = outputSimilarity(currentOutput, lastOutput);
            if (similarity > SIMILARITY_THRESHOLD) {
              logger.error(
                `Loop detected: attempt ${attempt} output is ${Math.round(similarity * 100)}% similar to attempt ${attempt - 1}. ` +
                `Agent is stuck — bailing out early.`
              );
              feedback = `Loop detected: agent produced nearly identical output across attempts. Similarity: ${Math.round(similarity * 100)}%`;
              await this.sandbox.rollback(originalBranch);
              break;
            }
          }
          lastOutput = currentOutput;

          // 5. Write files to sandbox
          const allFiles = [...implementation.tests, ...implementation.code];
          const written = this.sandbox.writeFiles(allFiles);

          // 6. Run DETERMINISTIC quality gates (the algorithm decides)
          this.events.emit('taskProgress', { 
            id: task.id, 
            attempt, 
            phase: 'quality-gates',
            message: 'Running quality gates (TypeScript, Tests, Lint)...'
          });
          const qualityReport = await runQualityGates(this.state.projectDir);

          if (!qualityReport.allBlockingPassed) {
            feedback = formatGateFailures(qualityReport);
            logger.info(`Quality gates failed:\n${feedback.substring(0, 300)}`);
            await this.sandbox.rollback(originalBranch);
            continue;
          }

          // 7. Gates passed — commit with full details
          await this.sandbox.commit(`TDD: ${task.description.substring(0, 50)}`, {
            attempt,
            gateResults: qualityReport.gates.map((g) => ({
              gate: g.gate,
              passed: g.passed,
              blocking: g.blocking,
            })),
            testMetrics: qualityReport.testMetrics,
            coverageMetrics: qualityReport.coverageMetrics,
            filesChanged: written,
          });

          // 8. LLM review (ADVISORY — gates already passed)
          this.events.emit('taskProgress', { 
            id: task.id, 
            attempt, 
            phase: 'review',
            message: 'Waiting for adversarial review...'
          });
          const review = await reviewImplementation(
            this.state.getState().original_request,
            task.description,
            implementation.tests,
            implementation.code,
            qualityReport,
            this.llm
          );

          if (!review.approved) {
            logger.info(`Review rejected (advisory): ${review.feedback.substring(0, 200)}`);
            feedback = review.feedback;
            await this.sandbox.rollback(originalBranch);
            continue;
          }

          // 9. Approved! Merge with reviewer details in commit.
          await this.sandbox.commit(`TDD: ${task.description.substring(0, 50)}`, {
            attempt,
            gateResults: qualityReport.gates.map((g) => ({
              gate: g.gate,
              passed: g.passed,
              blocking: g.blocking,
            })),
            testMetrics: qualityReport.testMetrics,
            coverageMetrics: qualityReport.coverageMetrics,
            reviewerScore: review.scores.test_coverage + review.scores.integration + review.scores.error_handling + review.scores.security,
            reviewerSummary: review.feedback.substring(0, 200),
            filesChanged: written,
          });

          approved = true;
          await this.sandbox.mergeAndCleanup(branchName, originalBranch);
          this.state.updateSubtask(task.id, {
            status: 'completed',
            tests_written: true,
            code_implemented: true,
          });
          logger.info(`Task ${task.id} completed and merged!`);
          this.events.emit('taskCompleted', { id: task.id, task: this.state.getState().subtasks.find((t) => t.id === task.id) });
        } catch (err) {
          logger.error(`Attempt ${attempt} error: ${err}`);
          feedback = `Runtime error: ${err}`;
          try {
            await this.sandbox.rollback(originalBranch);
          } catch {
            /* best-effort rollback */
          }
        }
      }

      if (approved) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        logger.error(`Task ${task.id} failed after ${MAX_ATTEMPTS} attempts (consecutive failures: ${consecutiveFailures})`);
        this.state.updateSubtask(task.id, { status: 'failed', feedback });
        
        const subtaskObj = this.state.getState().subtasks.find((t) => t.id === task.id);
        this.events.emit('taskFailed', { 
          id: task.id, 
          task: subtaskObj,
          feedback,
          isCircuitBroken: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES 
        });

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error(
            `Circuit breaker: ${consecutiveFailures} consecutive task failures. ` +
            `Stopping workflow to prevent wasted compute. Resume with retryFailed=true to try again.`
          );
          break;
        }
      }
    }
  }
}

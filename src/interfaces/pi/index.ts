import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StateManager } from '../../orchestrator/state.js';
import { WorkflowExecutor } from '../../orchestrator/executor.js';
import {
  ModelRouter,
  discoverModels,
  fetchCloudModels,
  loadConfig,
  loadGlobalConfig,
  mergeConfigs,
  saveConfig,
  type ModelProfile,
  type ModelRouterConfig,
  type TaskType,
} from '../../llm/model-router.js';
import { SearchClient } from '../../search/searxng.js';
import { analyzeProject, isAnalysisStale } from '../../analysis/runner.js';
import { runQualityGates } from '../../orchestrator/quality-gates.js';
import type { CoverageMetrics } from '../../orchestrator/quality-gates.js';
import { getTestRunner } from '../../orchestrator/test-runner.js';
import { planProject } from '../../agents/project-planner.js';
import { EpicLoader } from '../../orchestrator/epic-loader.js';
import { performDeepResearch, findResearchDirs, loadResearchState } from '../../agents/researcher.js';
import { getLogger } from '../../utils/logger.js';
import { readPiLlamaCppProviders, readPiCachedModels, readPiCachedModelInfo, readPiCloudProviders } from './pi-models.js';

// Gate output can be 10MB+ from large monorepo test runs. The planner only
// needs enough to identify failing files/tests — not full stack traces.
// The full output is available at reportPath for agents that need more detail.
function truncateGateOutput(output: string, reportPath?: string, maxLines = 150, maxChars = 8000): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines && output.length <= maxChars) return output;

  const truncatedByLines = lines.slice(0, maxLines).join('\n');
  const truncated = truncatedByLines.length > maxChars
    ? truncatedByLines.slice(0, maxChars)
    : truncatedByLines;

  const omittedLines = lines.length - maxLines;
  const suffix = reportPath
    ? `Full output: ${reportPath}`
    : 'run the gate locally for full output';
  const note = omittedLines > 0
    ? `\n[… ${omittedLines} lines truncated — ${suffix} …]`
    : `\n[… output truncated — ${suffix} …]`;
  return truncated + note;
}

function guessArchitecture(modelId: string): 'moe' | 'dense' | 'unknown' {
  const lower = modelId.toLowerCase();
  // MoE indicators: explicit "moe", active-param suffix like "a3b"/"a22b",
  // or the "30b-a3b" / "30ba3b" total+active pattern
  if (lower.includes('moe') || /a\d+b/.test(lower) || /\d+b[_-]?a\d+b/.test(lower)) return 'moe';
  if (lower.includes('instruct') || lower.includes('chat') || /\d+b/.test(lower)) return 'dense';
  return 'unknown';
}

export default function(pi: ExtensionAPI) {
  let executor: WorkflowExecutor | null = null;
  let stateManager: StateManager | null = null;

  // --------------------------------------------------------------------------
  // Chat input bridge — lets planning / interactive flows receive user replies
  // directly from Pi's chat input area rather than via modal dialogs.
  //
  // Single-slot by design: at most one flow can be waiting for the user at any
  // given time (the executor serialises its agent phases, and /plan and /tdd
  // own the chat turn while active). If a second waiter tries to register
  // while one is already pending, we cancel the stale waiter (returns null to
  // its caller) so it can clean up, and log a warning — this is almost always
  // a leaked state bug rather than intentional concurrency.
  // --------------------------------------------------------------------------
  let chatInputResolve: ((value: string | null) => void) | null = null;

  /**
   * Wait for the user to type something in Pi chat. Returns null if cancelled.
   * If another waiter is already pending it is cancelled first (they receive null).
   */
  const waitForChatInput = (): Promise<string | null> =>
    new Promise((resolve) => {
      if (chatInputResolve) {
        getLogger().warn('[PI] waitForChatInput called while another waiter is pending — cancelling the previous one');
        const stale = chatInputResolve;
        chatInputResolve = null;
        try { stale(null); } catch { /* previous caller already gone */ }
      }
      chatInputResolve = resolve;
    });

  /** Cancel a pending waitForChatInput (e.g. on error). Safe to call unconditionally. */
  const cancelChatInput = () => {
    if (chatInputResolve) {
      const resolve = chatInputResolve;
      chatInputResolve = null;
      try { resolve(null); } catch { /* caller already gone */ }
    }
  };

  /** Helper: post a message to Pi chat history without triggering a turn. */
  const postToChat = (content: string, customType = 'plan-progress') => {
    try {
      pi.sendMessage(
        { customType, content, display: true, details: {} },
        { triggerTurn: false }
      );
    } catch { /* non-fatal */ }
  };

  // Intercept interactive user messages while chatInputResolve is set.
  pi.on('input', async (event) => {
    if (!chatInputResolve || event.source !== 'interactive') return;
    const resolve = chatInputResolve;
    chatInputResolve = null;
    resolve(event.text);
    return { action: 'handled' };
  });

  pi.registerCommand('tdd', {
    description: 'Start or resume a TDD Epic. Usage: /tdd <epic> | /tdd <epic> retry | /tdd <epic> resume | /tdd <epic> continue | /tdd <epic> task <id> [retry|resume]',
    handler: async (args: string, ctx) => {
      if (!args) {
        args = await ctx.ui.input('Enter TDD Epic number or description (append "retry", "resume", "continue", or "task <id>"):') || '';
        if (!args) return;
      }

      // Parse subcommand variants:
      //   /tdd 1                       — start new
      //   /tdd 1 retry|resume|continue — resume whole epic
      //   /tdd 1 task WI-36            — run single task (retry mode, clears feedback)
      //   /tdd 1 task WI-36 resume     — run single task (resume mode, preserves feedback)
      const parts = args.trim().split(/\s+/);
      const epicRef = parts[0] ?? '';
      const subcommand = parts[1]?.toLowerCase();
      const isResume = subcommand === 'retry' || subcommand === 'resume' || subcommand === 'continue';
      const isSingleTask = subcommand === 'task';

      // Lazy init orchestrator state
      if (!executor) {
        stateManager = new StateManager(ctx.cwd);
        const modelRouter = new ModelRouter(null, ctx.cwd);
        if (modelRouter.isPassthrough) {
          ctx.ui.notify(
            "⚠️  No models.config.json found — using Pi's active model for all TDD sub-agents. " +
            'Create models.config.json to enable model routing.',
            'warning'
          );
        }

        const searchClient = process.env.SEARXNG_URL ? new SearchClient(process.env.SEARXNG_URL) : null;

        executor = new WorkflowExecutor(stateManager, modelRouter, {
          searchClient,
          chatMessage: (content, type) => postToChat(content, type ?? 'tdd-orchestrator'),
          waitForInput: async (prompt: string) => {
            postToChat(`💬 ${prompt}`, 'tdd-question');
            return await waitForChatInput();
          },
        });

        // Bind UI events
        executor.events.on('taskStarted', (data: { description: string }) => {
          ctx.ui.setStatus('tdd', `⚙️  [TDD] Starting: ${data.description.substring(0, 30)}...`);
        });

        executor.events.on('taskProgress', (data: { attempt: number, message: string }) => {
          ctx.ui.setStatus('tdd', `⚙️  [TDD] Attempt ${data.attempt}: ${data.message}`);
        });

        executor.events.on('taskCompleted', async (data: { id: string }) => {
          ctx.ui.notify(`✅ [TDD] Task completed: ${data.id}`, 'info');
        });

        executor.events.on('taskFailed', async (data: { id: string, feedback: string }) => {
          ctx.ui.notify(`❌ [TDD] Task failed: ${data.id}`, 'error');
          ctx.ui.setStatus('tdd', undefined);
        });
      }

      const runAndReport = (promise: Promise<void>) => {
        ctx.ui.notify('TDD Workflow running in background...', 'info');
        promise.then(() => {
          const summary = stateManager!.getSummary();
          ctx.ui.setStatus('tdd', undefined);
          if (summary.failed > 0 || summary.pending > 0) {
            ctx.ui.notify(
              `⏸ TDD paused — ${summary.failed} failed, ${summary.pending} pending, ${summary.completed} done.`,
              'warning'
            );
          } else {
            ctx.ui.notify(`🎉 TDD Epic Complete! ${summary.completed} subtasks implemented.`, 'info');
          }
        }).catch((err: any) => {
          ctx.ui.setStatus('tdd', undefined);
          cancelChatInput();
          ctx.ui.notify(`🔥 TDD Engine Error: ${err.message}`, 'error');
        });
      };

      if (isSingleTask) {
        if (!stateManager!.hasWorkflow()) {
          ctx.ui.notify(`No active workflow for epic "${epicRef}". Run /tdd ${epicRef} to start one.`, 'warning');
          return;
        }
        const taskId = parts[2];
        if (!taskId) {
          ctx.ui.notify('Usage: /tdd <epic> task <task-id>  e.g. /tdd 6 task WI-36', 'warning');
          return;
        }
        const taskMode = parts[3]?.toLowerCase() === 'resume' ? 'resume' : 'retry';
        postToChat(
          `🎯 Running single task **${taskId}** for epic **${epicRef}** (mode=${taskMode})…`,
          'tdd-progress'
        );
        runAndReport(executor!.runTask(taskId, taskMode));
      } else if (isResume) {
        if (!stateManager!.hasWorkflow()) {
          ctx.ui.notify(`No active workflow for epic "${epicRef}". Run /tdd ${epicRef} to start one.`, 'warning');
          return;
        }
        const mode = subcommand === 'retry' ? 'retry'
          : subcommand === 'resume' ? 'resume'
          : 'skip';
        const modeLabel = mode === 'retry'
          ? `🔄 Retrying failed tasks for epic **${epicRef}** (reviewer feedback cleared)…`
          : mode === 'resume'
          ? `▶️ Resuming failed tasks for epic **${epicRef}** (reviewer feedback preserved)…`
          : `▶️ Continuing epic **${epicRef}** (skipping failed tasks)…`;
        postToChat(modeLabel, 'tdd-progress');
        runAndReport(executor!.resume(mode));
      } else {
        runAndReport(executor!.startNew(epicRef));
      }
    }
  });

  pi.registerCommand('review', {
    description: 'Run the hostile code reviewer outside the TDD cycle. Usage: /review [uncommitted|<n>|all] [epic <ref>] [<description>]',
    handler: async (args: string, ctx) => {
      if (!args) {
        args = await ctx.ui.input(
          'Scope: uncommitted | <number of commits> | all\n' +
          'Optionally append: epic <ref>  or a plain description\n\n' +
          'Examples: uncommitted  /  3  /  all epic 2  /  uncommitted "fixed auth"'
        ) || '';
        if (!args) return;
      }

      const tokens = args.trim().split(/\s+/);
      const scope = tokens[0] ?? 'uncommitted';
      const rest = tokens.slice(1).join(' ').trim();

      // Extract optional epic ref: "epic <ref>" anywhere in the remainder
      let context: string | undefined;
      const epicMatch = rest.match(/^epic\s+(\S+)(.*)/i);
      if (epicMatch) {
        const epicRef = epicMatch[1]!;
        const extraDesc = epicMatch[2]?.trim();
        try {
          if (!stateManager) stateManager = new StateManager(ctx.cwd);
          const epicLoader = new EpicLoader(ctx.cwd);
          const epicPath = epicLoader.findEpic(epicRef);
          if (epicPath) {
            const epic = epicLoader.parseEpic(epicPath);
            context = `**Epic: ${epic.title}**\n${epic.summary || ''}\n\nWork Items:\n` +
              epic.workItems.map(wi => `- **${wi.id}**: ${wi.description}`).join('\n');
            if (extraDesc) context += `\n\n**Additional context:** ${extraDesc}`;
          } else {
            ctx.ui.notify(`Epic "${epicRef}" not found — reviewing without epic context.`, 'warning');
            context = extraDesc || undefined;
          }
        } catch {
          context = extraDesc || undefined;
        }
      } else if (rest) {
        context = rest;
      }

      if (!executor) {
        stateManager = new StateManager(ctx.cwd);
        const modelRouter = new ModelRouter(null, ctx.cwd);
        executor = new WorkflowExecutor(stateManager, modelRouter, {
          chatMessage: (content, type) => postToChat(content, type ?? 'tdd-orchestrator'),
        });
      }

      ctx.ui.setStatus('review', '🔍 Reviewing…');
      ctx.ui.notify('Review running in background…', 'info');
      executor.runStandaloneReview(scope, context)
        .then(() => ctx.ui.setStatus('review', undefined))
        .catch((err: any) => {
          ctx.ui.setStatus('review', undefined);
          ctx.ui.notify(`🔥 Review error: ${err.message}`, 'error');
        });
    },
  });

  pi.registerCommand('plan', {
    description: 'Structure a new project or large feature into epics and work items',
    handler: async (args: string, ctx) => {
      if (!args) {
        args = await ctx.ui.input('Enter project or feature description:') || '';
        if (!args) return;
      }

      ctx.ui.notify('Project Planner starting...', 'info');
      ctx.ui.setStatus('plan', '📐 Planning project structure...');

      try {
        // 1. Check if analysis is stale. If so, run it first.
        if (isAnalysisStale(ctx.cwd)) {
          ctx.ui.setStatus('plan', '🔍 Running fresh code analysis first...');
          await analyzeProject(ctx.cwd);
        }

        const modelRouter = new ModelRouter(null, ctx.cwd);
        if (modelRouter.isPassthrough) {
          ctx.ui.notify(
            "⚠️  No models.config.json found — using Pi's active model for planning.",
            'warning'
          );
        }
        const result = await planProject(args, modelRouter, ctx.cwd, {
          // Clarifying questions: post to chat and wait for the user to reply inline.
          input: async (prompt: string) => {
            postToChat(`❓ **${prompt}**\n\n_Type your answer in the chat…_`, 'plan-question');
            return await waitForChatInput();
          },
          notify: (message: string, type?: 'info' | 'warning' | 'error') => ctx.ui.notify(message, type || 'info'),
          // Plan review: post the plan markdown to chat and ask for approval or feedback.
          editor: async (_label: string, initialText: string) => {
            postToChat(initialText, 'plan-review');
            postToChat(
              '---\n✅ Type **`approve`** to create the WorkItems, or describe what you\'d like changed.',
              'plan-review-prompt'
            );
            const response = await waitForChatInput();
            if (!response) return null; // cancelled / timed out
            const trimmed = response.trim().toLowerCase();
            if (trimmed === 'approve' || trimmed === 'yes' || trimmed === 'y') {
              return initialText; // approved as-is — project-planner will write files
            }
            // User provided feedback — post a hint and cancel this planning round.
            postToChat(
              `📝 Got it. Run \`/plan ${args}\` again and the planner will incorporate your feedback:\n\n> ${response}`,
              'plan-feedback'
            );
            return null;
          },
          // confirm is reached only if editor returned non-null; auto-approve so we
          // don't show a second dialog after the chat-based review above.
          confirm: async (_message: string) => true,
          chatMessage: (content: string) => postToChat(content),
        });
        
        ctx.ui.setStatus('plan', undefined);
        ctx.ui.notify(result.summary, 'info');

      } catch (err) {
        ctx.ui.setStatus('plan', undefined);
        cancelChatInput(); // release any pending chat-input waiter
        const e = err as Error;
        ctx.ui.notify(`Planning failed: ${e.message}`, 'error');
      }
    }
  });

  pi.registerCommand('tdd:project-cleanup', {
    description: 'Audit quality gates across the whole project and create a TDD workflow to fix all pre-existing failures.',
    handler: async (_args: string, ctx) => {
      ctx.ui.notify('Scanning project for quality gate failures…', 'info');
      ctx.ui.setStatus('tdd-cleanup', '🔍 Running quality gates…');

      let report;
      try {
        report = await runQualityGates(ctx.cwd, { collectCoverage: true });
      } catch (err) {
        ctx.ui.setStatus('tdd-cleanup', undefined);
        ctx.ui.notify(`Quality gate scan failed: ${(err as Error).message}`, 'error');
        return;
      }

      ctx.ui.setStatus('tdd-cleanup', undefined);

      const failures = report.gates.filter(g => !g.passed);
      if (failures.length === 0) {
        ctx.ui.notify('✅ All quality gates pass — nothing to clean up!', 'info');
        postToChat('✅ **Project Cleanup** — all quality gates pass. No cleanup needed.', 'tdd-progress');
        return;
      }

      // Summarise what's broken
      const failureSummary = failures
        .map(g => `- **${g.gate}** (${g.blocking ? 'BLOCKING' : 'warning'}): ${g.output.split('\n')[0]}`)
        .join('\n');

      postToChat(
        `🧹 **Project Cleanup** — found ${failures.length} failing gate${failures.length === 1 ? '' : 's'}:\n${failureSummary}\n\nStarting cleanup workflow…`,
        'tdd-progress'
      );

      // Format coverage snapshot for the planner — informational only, never blocking.
      const cov: CoverageMetrics | undefined = report.coverageMetrics;
      const coverageSection = cov
        ? `\n\n## Current Coverage (informational — not a failing gate)\n` +
          `Lines: ${cov.lines}%  |  Functions: ${cov.functions}%  |  Branches: ${cov.branches}%\n\n` +
          `If coverage is notably low (<60%) for any area, include a subtask to add tests for that area. ` +
          `Do NOT fail the workflow or block on coverage — just include it if meaningful.`
        : '';

      // Build a structured cleanup request for the on-the-fly planner.
      // Gate output is truncated — the planner only needs file paths and error
      // summaries, not full stack traces. Agents can read report.reportPath for
      // the complete output when they need more detail.
      const cleanupRequest =
        `Fix all pre-existing quality gate failures in this project.\n\n` +
        `## Failing Gates\n\n` +
        failures.map(g =>
          `### ${g.gate.toUpperCase()} (${g.blocking ? 'BLOCKING' : 'warning'})\n${truncateGateOutput(g.output, report.reportPath)}`
        ).join('\n\n') +
        coverageSection +
        `\n\n## Rules\n` +
        `- Fix ONLY what is explicitly listed above. Do not refactor unrelated code.\n` +
        `- Each subtask should be scoped to a single package or file group.\n` +
        `- Commit fixes separately from any feature work.\n` +
        `- **pi-lens-ignore**: For issues that are genuinely unfixable (e.g. a third-party type mismatch, a generated file, or a pattern that is architecturally intentional), suppress with \`// pi-lens-ignore\` and add an inline comment on the line above explaining why. The goal is a clean \`/lens-booboo\` report — use suppression to silence real false positives, not to avoid real fixes.\n` +
        `- After all fixes are committed, run \`/lens-booboo\` (if available) and confirm the report is clean before signalling DONE.`;

      // Lazy-init the same executor used by /tdd so event wiring is shared.
      if (!executor) {
        stateManager = new StateManager(ctx.cwd);
        const modelRouter = new ModelRouter(null, ctx.cwd);
        if (modelRouter.isPassthrough) {
          ctx.ui.notify(
            "⚠️  No models.config.json found — using Pi's active model for cleanup agents.",
            'warning'
          );
        }
        const searchClient = process.env.SEARXNG_URL ? new SearchClient(process.env.SEARXNG_URL) : null;

        executor = new WorkflowExecutor(stateManager, modelRouter, {
          searchClient,
          chatMessage: (content, type) => postToChat(content, type ?? 'tdd-orchestrator'),
          waitForInput: async (prompt: string) => {
            postToChat(`💬 ${prompt}`, 'tdd-question');
            return await waitForChatInput();
          },
        });

        executor.events.on('taskStarted', (data: { description: string }) => {
          ctx.ui.setStatus('tdd-cleanup', `🧹 [Cleanup] ${data.description.substring(0, 40)}…`);
        });
        executor.events.on('taskProgress', (data: { attempt: number; message: string }) => {
          ctx.ui.setStatus('tdd-cleanup', `🧹 [Cleanup] Attempt ${data.attempt}: ${data.message}`);
        });
        executor.events.on('taskCompleted', (data: { id: string }) => {
          ctx.ui.notify(`✅ [Cleanup] Fixed: ${data.id}`, 'info');
        });
        executor.events.on('taskFailed', (data: { id: string }) => {
          ctx.ui.notify(`❌ [Cleanup] Could not fix: ${data.id}`, 'error');
          ctx.ui.setStatus('tdd-cleanup', undefined);
        });
      }

      ctx.ui.notify('Cleanup workflow running in background…', 'info');
      executor!.startNew(cleanupRequest).then(() => {
        const summary = stateManager!.getSummary();
        ctx.ui.setStatus('tdd-cleanup', undefined);
        if (summary.failed > 0 || summary.pending > 0) {
          ctx.ui.notify(
            `⏸ Cleanup paused — ${summary.failed} failed, ${summary.pending} pending, ${summary.completed} fixed.`,
            'warning'
          );
        } else {
          ctx.ui.notify(`🎉 Project cleanup complete! ${summary.completed} issue${summary.completed === 1 ? '' : 's'} fixed.`, 'info');
        }
      }).catch((err: any) => {
        ctx.ui.setStatus('tdd-cleanup', undefined);
        cancelChatInput();
        ctx.ui.notify(`🔥 Cleanup engine error: ${err.message}`, 'error');
      });
    }
  });

  pi.registerCommand('tdd:pause', {
    description: 'Gracefully pause the active TDD workflow after the current agent turn. WIP branch is preserved; use /tdd:resume to continue.',
    handler: async (_args: string, ctx) => {
      if (!executor) {
        ctx.ui.notify('No TDD workflow is currently running.', 'warning');
        return;
      }
      if (executor.isInterrupted()) {
        ctx.ui.notify('An interrupt is already pending. Wait for it to complete.', 'warning');
        return;
      }
      executor.requestPause();
      ctx.ui.notify('Pause requested — the workflow will stop after the current agent turn.', 'info');
    },
  });

  pi.registerCommand('tdd:stop', {
    description: 'Immediately stop the active TDD workflow: abort the running agent, roll back the current task, and reset it to pending. Other tasks are untouched.',
    handler: async (_args: string, ctx) => {
      if (!executor) {
        ctx.ui.notify('No TDD workflow is currently running.', 'warning');
        return;
      }
      executor.requestStop();
      ctx.ui.notify('Stop requested — rolling back the current task.', 'info');
    },
  });

  pi.registerCommand('tdd:resume', {
    description: 'Resume a previously paused TDD workflow. Picks up paused tasks with their WIP branch + feedback intact.',
    handler: async (_args: string, ctx) => {
      if (!stateManager) {
        stateManager = new StateManager(ctx.cwd);
      }
      if (!stateManager.hasWorkflow()) {
        ctx.ui.notify('No workflow state found in this project. Use /tdd to start one.', 'warning');
        return;
      }
      if (!stateManager.hasPausedTasks()) {
        ctx.ui.notify('No paused tasks to resume. Use /tdd <epic> resume to retry failed tasks.', 'info');
        return;
      }

      // Lazily construct executor with the same wiring as /tdd if it isn't already.
      if (!executor) {
        const modelRouter = new ModelRouter(null, ctx.cwd);
        const searchClient = process.env.SEARXNG_URL ? new SearchClient(process.env.SEARXNG_URL) : null;
        executor = new WorkflowExecutor(stateManager, modelRouter, {
          searchClient,
          chatMessage: (content, type) => postToChat(content, type ?? 'tdd-orchestrator'),
          waitForInput: async (prompt: string) => {
            postToChat(`💬 ${prompt}`, 'tdd-question');
            return await waitForChatInput();
          },
        });
      }

      ctx.ui.notify('Resuming paused workflow…', 'info');
      postToChat('▶️ Resuming paused workflow…', 'tdd-progress');
      executor.resume('skip').then(() => {
        const summary = stateManager!.getSummary();
        ctx.ui.setStatus('tdd', undefined);
        if (summary.failed > 0 || summary.pending > 0 || summary.paused > 0) {
          ctx.ui.notify(
            `⏸ TDD paused/incomplete — ${summary.failed} failed, ${summary.paused} paused, ${summary.pending} pending, ${summary.completed} done.`,
            'warning'
          );
        } else {
          ctx.ui.notify(`🎉 TDD Epic Complete! ${summary.completed} subtasks implemented.`, 'info');
        }
      }).catch((err: any) => {
        ctx.ui.setStatus('tdd', undefined);
        cancelChatInput();
        ctx.ui.notify(`🔥 TDD Engine Error: ${err.message}`, 'error');
      });
    },
  });

  pi.registerCommand('tdd:test', {
    description: 'Run the test suite and report failing tests',
    handler: async (_args: string, ctx) => {
      const runner = getTestRunner(ctx.cwd);
      if (!runner) {
        ctx.ui.notify('No test runner detected in this project.', 'warning');
        return;
      }

      ctx.ui.notify(`Running ${runner.name} tests…`, 'info');
      ctx.ui.setStatus('tdd-test', `🧪 Running ${runner.name}…`);

      try {
        const result = await runner.runTests(ctx.cwd, 600_000);
        ctx.ui.setStatus('tdd-test', undefined);

        const m = result.metrics;
        const summary = m
          ? `${m.passed}/${m.total} passed` +
            (m.failed > 0 ? ` · **${m.failed} failed**` : '') +
            (m.skipped > 0 ? ` · ${m.skipped} skipped` : '')
          : result.passed ? 'All tests passed' : 'Tests failed';

        const icon = result.passed ? '✅' : '❌';
        const outputBlock = result.output
          ? `\n\n\`\`\`\n${result.output.length > 4000 ? result.output.slice(-4000) + '\n…(truncated — showing last 4000 chars)' : result.output}\n\`\`\``
          : '';

        postToChat(`${icon} **Test Results** — ${summary}${outputBlock}`, 'tdd-progress');
        ctx.ui.notify(`${icon} Tests: ${summary}`, result.passed ? 'info' : 'warning');
      } catch (err) {
        ctx.ui.setStatus('tdd-test', undefined);
        ctx.ui.notify(`Test run failed: ${(err as Error).message}`, 'error');
      }
    },
  });

  pi.registerCommand('analyze', {
    description: 'Run architectural analysis on the repository',
    handler: async (args: string, ctx) => {
      ctx.ui.notify('Analyzing project dependencies and patterns...', 'info');
      ctx.ui.setStatus('analyze', '🔍 Analyzing project...');
      
      try {
        const result = await analyzeProject(ctx.cwd);
        ctx.ui.setStatus('analyze', undefined);
        
        ctx.ui.notify(
           `Analysis Complete:\n` +
           `- Modules: ${result.results.length}\n` +
           `- Patterns: ${result.results.flatMap((r: any) => r.patterns || []).map((p: any) => p.pattern).slice(0, 5).join(', ')}...`,
           'info'
        );
      } catch (err) {
        ctx.ui.setStatus('analyze', undefined);
        const e = err as Error;
        ctx.ui.notify(`Analysis failed: ${e.message}`, 'error');
      }
    }
  });

  pi.registerCommand('research', {
    description: 'Launch a Deep Research Agent. Flags: --bg (background), --shallow (single-pass), --time N (minutes, default 30), --resume [folder] (continue previous session)',
    handler: async (args: string, ctx) => {
      // Parse flags from args
      let isBackground = false;
      let isShallow = false;
      let timeLimitMinutes: number | undefined;
      let resumeDir: string | undefined;
      let topic = args.trim();

      // Extract flags (order-independent, can appear anywhere)
      topic = topic.replace(/\s+--?(bg|background)\b/gi, () => { isBackground = true; return ''; });
      topic = topic.replace(/\s+--?shallow\b/gi, () => { isShallow = true; return ''; });
      topic = topic.replace(/\s+--?time\s+(\d+)/gi, (_match, mins) => { timeLimitMinutes = parseInt(mins, 10); return ''; });
      topic = topic.replace(/\s+--?resume(?:\s+(\S+))?/gi, (_match, folder) => { resumeDir = folder || 'latest'; return ''; });
      topic = topic.trim();

      // Handle resume mode
      if (resumeDir) {
        if (resumeDir === 'latest') {
          const dirs = findResearchDirs(ctx.cwd);
          if (dirs.length === 0) {
            ctx.ui.notify('No previous research sessions found to resume.', 'warning');
            return;
          }
          // If multiple sessions exist, let user pick
          if (dirs.length > 1) {
            const choices = dirs.map(d => {
              const state = loadResearchState(ctx.cwd, d);
              const label = state
                ? `${d} — "${state.topic}" (${state.allQuestionsResearched.length} questions, round ${state.currentRound})`
                : d;
              return label;
            });
            const choice = await ctx.ui.input(
              `Select session to resume:\n${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nEnter number (1-${choices.length}):`
            );
            if (!choice) return;
            const idx = parseInt(choice, 10) - 1;
            if (idx < 0 || idx >= dirs.length) {
              ctx.ui.notify('Invalid selection.', 'warning');
              return;
            }
            resumeDir = dirs[idx]!;
          } else {
            resumeDir = dirs[0]!;
          }
        }

        // For resume, topic is loaded from state (pass empty string)
        topic = '';
      }

      if (!topic && !resumeDir) {
        topic = await ctx.ui.input('Enter research topic (flags: --bg, --shallow, --time N, --resume):') || '';
        if (!topic) return;

        // Re-parse flags from interactive input
        topic = topic.replace(/\s+--?(bg|background)\b/gi, () => { isBackground = true; return ''; });
        topic = topic.replace(/\s+--?shallow\b/gi, () => { isShallow = true; return ''; });
        topic = topic.replace(/\s+--?time\s+(\d+)/gi, (_match, mins) => { timeLimitMinutes = parseInt(mins, 10); return ''; });
        topic = topic.replace(/\s+--?resume(?:\s+(\S+))?/gi, (_match, folder) => { resumeDir = folder || 'latest'; return ''; });
        topic = topic.trim();
      }

      const modelRouter = new ModelRouter(null, ctx.cwd);
      if (modelRouter.isPassthrough) {
        ctx.ui.notify(
          "⚠️  No models.config.json found — using Pi's active model for research.",
          'warning'
        );
      }
      const searchClient = process.env.SEARXNG_URL ? new SearchClient(process.env.SEARXNG_URL) : null;

      await performDeepResearch(topic, ctx.cwd, modelRouter, searchClient, {
        background: isBackground,
        shallow: isShallow,
        timeLimitMinutes,
        resumeDir,
        uiContext: ctx.ui,
        chatMessage: (content: string) => {
          try {
            pi.sendMessage(
              { customType: 'research-progress', content, display: true, details: {} },
              { triggerTurn: false }
            );
          } catch (err) {
            // pi.sendMessage() can occasionally interfere with an active agent session.
            // Swallow the error — the message is also delivered via uiContext.notify().
            const logger = getLogger();
            logger.warn(`[PI] chatMessage sendMessage failed (non-fatal): ${(err as Error).message}`);
          }
        },
      });
    }
  });

  pi.registerCommand('setup', {
    description: 'Configure model routing for TDD/research agents. Use --global to save system-wide.',
    handler: async (args: string, ctx) => {
      const isGlobal = args.includes('--global');

      ctx.ui.notify('TDD Workflow — Model Setup', 'info');

      // Internal type used only within this wizard — carries provider context
      // alongside the model ID so we can build the right ModelProfile later.
      interface SetupModelEntry {
        displayName: string;
        provider: 'local' | 'openrouter' | 'openai' | 'custom';
        ggufFilename?: string;   // local models
        modelId?: string;        // cloud models
        apiKeyEnvVar?: string;   // cloud models
        contextLength?: number;
        maxOutputTokens?: number;
        reasoning?: boolean;
      }

      // ── 1. Resolve llamaUrl ────────────────────────────────────────────
      const existingConfig = isGlobal ? loadGlobalConfig() : loadConfig(ctx.cwd);
      let llamaUrl = process.env['LLAMA_CPP_URL'] || existingConfig?.llamaCppUrl || 'http://localhost:8080/v1';

      const piProviders = readPiLlamaCppProviders();
      if (piProviders.length === 1) {
        llamaUrl = piProviders[0]!.baseUrl;
        ctx.ui.notify(`Using Pi llama.cpp provider: ${piProviders[0]!.name} (${llamaUrl})`, 'info');
      } else if (piProviders.length > 1) {
        const providerList = piProviders.map((p, i) => `${i + 1}. ${p.name}  ${p.baseUrl}`).join('\n');
        ctx.ui.notify(`Pi llama.cpp providers:\n${providerList}`, 'info');
        const sel = await ctx.ui.input(`Select provider (1-${piProviders.length}) or paste a custom URL:`);
        const trimmed = sel?.trim() ?? '';
        if (trimmed.startsWith('http')) {
          llamaUrl = trimmed;
        } else {
          const idx = parseInt(trimmed, 10) - 1;
          if (idx >= 0 && idx < piProviders.length) llamaUrl = piProviders[idx]!.baseUrl;
        }
      } else if (!process.env['LLAMA_CPP_URL'] && !existingConfig?.llamaCppUrl) {
        const urlInput = await ctx.ui.input(`llama.cpp API URL [${llamaUrl}]:`);
        llamaUrl = urlInput?.trim() || llamaUrl;
      }

      // ── 2. Discover all available local models ────────────────────────
      // Always fetch the full list — never limit to what was previously
      // configured, so newly loaded models always appear.
      let discovered = readPiCachedModels(llamaUrl);
      if (discovered.length > 0) {
        ctx.ui.notify(`Found ${discovered.length} cached models from Pi for ${llamaUrl}`, 'info');
      } else {
        ctx.ui.setStatus('setup', '🔍 Discovering models...');
        discovered = await discoverModels(llamaUrl);
        ctx.ui.setStatus('setup', undefined);
      }

      // Mark any model already in the config so the user can see at a glance
      // which ones are new vs already assigned.
      const configuredFilenames = new Set(
        Object.values(existingConfig?.models ?? {})
          .filter(p => p.provider === 'local')
          .map(p => p.ggufFilename)
          .filter(Boolean)
      );

      let localEntries: SetupModelEntry[] = [];
      if (discovered.length === 0) {
        ctx.ui.notify('No models found at that URL. Enter model IDs manually.', 'warning');
        const manual = await ctx.ui.input('Model IDs (comma-separated), or leave empty to cancel:');
        if (!manual?.trim()) return;
        localEntries = manual.split(',').map(s => s.trim()).filter(Boolean)
          .map(id => ({ displayName: id, provider: 'local' as const, ggufFilename: id }));
      } else {
        const listText = discovered.map((id, i) => {
          const marker = configuredFilenames.has(id) ? ' *' : '';
          return `${i + 1}. ${id}${marker}`;
        }).join('\n');
        const note = configuredFilenames.size > 0 ? '  (* = already configured)' : '';
        ctx.ui.notify(`Available models:${note}\n${listText}`, 'info');

        const sel = await ctx.ui.input('Select models to include (e.g. "1,3") or Enter for all:');
        const selectedIds = sel?.trim()
          ? sel.split(',').map(s => parseInt(s.trim(), 10) - 1)
              .filter(i => i >= 0 && i < discovered.length).map(i => discovered[i]!)
          : discovered;
        if (selectedIds.length === 0) {
          ctx.ui.notify('No valid selections. Setup cancelled.', 'warning');
          return;
        }
        localEntries = selectedIds.map(id => ({ displayName: id, provider: 'local' as const, ggufFilename: id }));
      }

      // ── 3. Discover cloud models from Pi's configured providers ──────
      // Pi's models.json already has API keys for cloud providers (e.g. OpenRouter).
      // Fetch their available model lists and offer them alongside local models.
      const cloudEntries: SetupModelEntry[] = [];
      const piCloudProviders = readPiCloudProviders();
      if (piCloudProviders.length > 0) {
        ctx.ui.setStatus('setup', '🌐 Fetching cloud models...');
        for (const cp of piCloudProviders) {
          const fetched = await fetchCloudModels(cp.baseUrl, cp.apiKey);
          // Determine the standard env var name for this provider's API key
          const apiKeyEnvVar = cp.baseUrl.includes('openrouter') ? 'OPENROUTER_API_KEY'
            : cp.baseUrl.includes('openai.com') ? 'OPENAI_API_KEY'
            : undefined;
          const provider: 'openrouter' | 'openai' | 'custom' =
            cp.baseUrl.includes('openrouter') ? 'openrouter'
            : cp.baseUrl.includes('openai.com') ? 'openai'
            : 'custom';
          for (const m of fetched) {
            cloudEntries.push({
              displayName: `${m.id}  (${Math.round(m.contextLength / 1000)}k ctx)  [${cp.name}]`,
              provider,
              modelId: m.id,
              apiKeyEnvVar,
              contextLength: m.contextLength,
              maxOutputTokens: m.maxOutputTokens,
              reasoning: m.reasoning,
            });
          }
        }
        ctx.ui.setStatus('setup', undefined);
        if (cloudEntries.length > 0) {
          ctx.ui.notify(`Found ${cloudEntries.length} cloud model(s) from ${piCloudProviders.length} provider(s).`, 'info');
        }
      }

      // ── 4. Assign a model to each agent ──────────────────────────────
      const taskTypes: Array<{ type: TaskType; label: string }> = [
        { type: 'plan',         label: 'Task planning / breakdown'  },
        { type: 'project-plan', label: 'Project-level planning'     },
        { type: 'implement',    label: 'Code implementation'        },
        { type: 'review',       label: 'Code review'                },
        { type: 'research',     label: 'Research'                   },
      ];

      // Combined list: local first, then cloud. Build the display text with a
      // separator so local vs cloud is visually clear.
      const allEntries: SetupModelEntry[] = [...localEntries, ...cloudEntries];
      const listLines: string[] = [];
      localEntries.forEach((e, i) => listLines.push(`${i + 1}. ${e.displayName}`));
      if (cloudEntries.length > 0) {
        listLines.push(`── cloud ──`);
        cloudEntries.forEach((e, i) =>
          listLines.push(`${localEntries.length + i + 1}. ${e.displayName}`)
        );
      }
      const listText = listLines.join('\n');

      const piModelInfo = readPiCachedModelInfo(llamaUrl);

      const models: Record<string, ModelProfile> = {};
      const routing: Partial<Record<TaskType, string>> = {};
      let lastKeyIdx = 0; // index into allEntries for default suggestion

      for (const { type, label } of taskTypes) {
        const defaultIdx = lastKeyIdx + 1;
        const input = await ctx.ui.input(
          `${listText}\n\n${type} — ${label} [${defaultIdx}]:`
        );
        const idx = Math.max(0, Math.min(
          parseInt(input?.trim() || String(defaultIdx), 10) - 1,
          allEntries.length - 1
        ));
        const entry = allEntries[idx]!;
        lastKeyIdx = idx;

        // Derive a stable config key from whichever identifier the entry has
        const rawId = entry.modelId ?? entry.ggufFilename ?? entry.displayName;
        const key = rawId.replace(/\.gguf$/i, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase().substring(0, 30);

        // Configure this model the first time it's selected
        if (!models[key]) {
          if (entry.provider === 'local') {
            // ── Local model ──────────────────────────────────────────
            const chosenId = entry.ggufFilename!;
            const cachedReasoning = piModelInfo.get(chosenId)?.reasoning ?? false;
            const thinkDefault = cachedReasoning ? 'Y/n' : 'y/N';
            const thinkInput = await ctx.ui.input(`Enable thinking/reasoning for "${chosenId}"? (${thinkDefault}):`);
            const enableThinking = thinkInput?.trim()
              ? thinkInput.toLowerCase().startsWith('y')
              : cachedReasoning;

            const arch = guessArchitecture(chosenId);
            const cached = piModelInfo.get(chosenId);
            models[key] = {
              name: chosenId,
              ggufFilename: chosenId,
              provider: 'local',
              contextWindow: cached?.contextWindow ?? 128_000,
              maxOutputTokens: cached?.maxTokens ?? 32_768,
              architecture: arch,
              speed: arch === 'moe' ? 'fast' : 'slow',
              enableThinking,
            };
          } else {
            // ── Cloud model (OpenRouter / OpenAI / custom) ────────────
            const modelId = entry.modelId!;
            const thinkDefault = entry.reasoning ? 'Y/n' : 'y/N';
            const thinkInput = await ctx.ui.input(`Enable thinking/reasoning for "${modelId}"? (${thinkDefault}):`);
            const enableThinking = thinkInput?.trim()
              ? thinkInput.toLowerCase().startsWith('y')
              : (entry.reasoning ?? false);

            const arch = guessArchitecture(modelId);
            models[key] = {
              name: modelId,
              modelId,
              provider: entry.provider,
              ...(entry.apiKeyEnvVar ? { apiKeyEnvVar: entry.apiKeyEnvVar } : {}),
              contextWindow: entry.contextLength ?? 128_000,
              maxOutputTokens: entry.maxOutputTokens ?? 32_768,
              architecture: arch,
              speed: arch === 'moe' ? 'fast' : 'slow',
              enableThinking,
            };
          }
        }

        routing[type] = key;
      }

      // ── 5. Save location ──────────────────────────────────────────────
      let saveGlobal = isGlobal;
      if (!isGlobal) {
        saveGlobal = await ctx.ui.confirm(
          'Save as global default?',
          'Yes → ~/.config/tdd-workflow/models.config.json  |  No → ./models.config.json'
        );
      }

      const newConfig: ModelRouterConfig = {
        ...(llamaUrl !== 'http://localhost:8080/v1' ? { llamaCppUrl: llamaUrl } : {}),
        models,
        routing,
      };

      // Merge with any existing config at the target location
      const existingAtTarget = saveGlobal ? loadGlobalConfig() : loadConfig(ctx.cwd);
      const finalConfig = existingAtTarget ? mergeConfigs(existingAtTarget, newConfig) : newConfig;

      const targetDir = saveGlobal ? path.join(os.homedir(), '.config', 'tdd-workflow') : ctx.cwd;
      fs.mkdirSync(targetDir, { recursive: true });
      saveConfig(finalConfig, targetDir);

      // ── 6. Summary ───────────────────────────────────────────────────
      const savedPath = path.join(targetDir, 'models.config.json');
      const routingSummary = taskTypes
        .map(({ type }) => `  ${type.padEnd(14)} → ${models[routing[type]!]?.name ?? routing[type]}`)
        .join('\n');
      ctx.ui.notify(`Saved to ${savedPath}\n\nRouting:\n${routingSummary}`, 'info');
    },
  });

  pi.on('session_shutdown', async () => {
    if (executor) {
      if ((executor as any).searchClient?.mcpPool) {
        await (executor as any).searchClient.mcpPool.disconnect();
      }
    }
  });
}

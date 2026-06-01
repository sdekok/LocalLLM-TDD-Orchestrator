import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
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
import { SearchClient, getSearxngUrl } from '../../search/searxng.js';
import { analyzeProject, isAnalysisStale } from '../../analysis/runner.js';
import { runQualityGates } from '../../orchestrator/quality-gates.js';
import type { CoverageMetrics } from '../../orchestrator/quality-gates.js';
import { getTestRunner } from '../../orchestrator/test-runner.js';
import { planProject, type PlanMode } from '../../agents/project-planner.js';
import { EpicLoader } from '../../orchestrator/epic-loader.js';
import { performDeepResearch, findResearchDirs, loadResearchState } from '../../agents/researcher.js';
import { getLogger } from '../../utils/logger.js';
import { readPiLlamaCppProviders, readPiCachedModels, readPiCachedModelInfo, readPiCloudProviders } from './pi-models.js';
import { completeTddArgs, completeReviewArgs, completeResearchArgs, completePlanArgs } from './autocomplete.js';
import { parsePlanArgs, listExistingEpics, readPriorRequest } from './plan-helpers.js';

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
    description: 'Start or resume a TDD Epic. Usage: /tdd <epic> | /tdd <epic> retry | /tdd <epic> resume | /tdd <epic> continue | /tdd <epic> task <id> [retry|resume|done]',
    getArgumentCompletions: (argumentPrefix: string) => completeTddArgs(process.cwd(), argumentPrefix),
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
      //   /tdd 1 WI-36 done            — mark task as externally completed, then continue
      const parts = args.trim().split(/\s+/);
      const epicRef = parts[0] ?? '';
      const subcommand = parts[1]?.toLowerCase();
      const isResume = subcommand === 'retry' || subcommand === 'resume' || subcommand === 'continue';
      const isSingleTask = subcommand === 'task';
      const isMarkDone = (parts[2]?.toLowerCase() === 'done' || parts[2]?.toLowerCase() === 'complete') && !!parts[1];

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

        const searxngUrl = getSearxngUrl();
        const searchClient = searxngUrl ? new SearchClient(searxngUrl) : null;

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

      if (isMarkDone) {
        if (!stateManager!.hasWorkflow()) {
          ctx.ui.notify(`No active workflow for epic "${epicRef}". Run /tdd ${epicRef} to start one.`, 'warning');
          return;
        }
        const taskId = parts[1]!;
        postToChat(
          `📌 Marking **${taskId}** as externally completed for epic **${epicRef}**…`,
          'tdd-progress'
        );
        runAndReport(executor!.markTaskDone(taskId));
      } else if (isSingleTask) {
        if (!stateManager!.hasWorkflow()) {
          ctx.ui.notify(`No active workflow for epic "${epicRef}". Run /tdd ${epicRef} to start one.`, 'warning');
          return;
        }
        const taskId = parts[2];
        if (!taskId) {
          ctx.ui.notify('Usage: /tdd <epic> task <task-id>  e.g. /tdd 6 task WI-36', 'warning');
          return;
        }
        const modeArg = parts[3]?.toLowerCase();
        if (modeArg === 'done' || modeArg === 'complete') {
          postToChat(`📌 Marking **${taskId}** as externally completed for epic **${epicRef}**…`, 'tdd-progress');
          runAndReport(executor!.markTaskDone(taskId));
        } else {
          const taskMode = modeArg === 'resume' ? 'resume' : 'retry';
          postToChat(
            `🎯 Running single task **${taskId}** for epic **${epicRef}** (mode=${taskMode})…`,
            'tdd-progress'
          );
          runAndReport(executor!.runTask(taskId, taskMode));
        }
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
    description: 'Run the hostile code reviewer outside the TDD cycle. Usage: /review [uncommitted|<n>|all|branch <name>] [epic <ref>] [<description>]',
    getArgumentCompletions: (argumentPrefix: string) => completeReviewArgs(process.cwd(), argumentPrefix),
    handler: async (args: string, ctx) => {
      if (!args) {
        args = await ctx.ui.input(
          'Scope: uncommitted | <number of commits> | all | branch <name>\n' +
          'Optionally append: epic <ref>  or a plain description\n\n' +
          'Examples: uncommitted  /  3  /  all epic 2  /  branch main  /  branch feature/ep06 epic 2'
        ) || '';
        if (!args) return;
      }

      const tokens = args.trim().split(/\s+/);
      let scope: string;
      let rest: string;
      if (tokens[0] === 'branch') {
        if (!tokens[1]) {
          // No branch name — find the branch this was created from via reflog
          scope = 'parent-branch';
          rest = tokens.slice(1).join(' ').trim();
        } else {
          scope = `branch:${tokens[1]}`;
          rest = tokens.slice(2).join(' ').trim();
        }
      } else {
        scope = tokens[0] ?? 'uncommitted';
        rest = tokens.slice(1).join(' ').trim();
      }

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
    description: 'Structure a new project or large feature into epics and work items. ' +
                 'Subcommands: list | show <epic> | revise [feedback]. ' +
                 'Flags: --replace (overwrite existing), --from-epic <id> (extend one epic), --brownfield.',
    getArgumentCompletions: (argumentPrefix: string) => completePlanArgs(process.cwd(), argumentPrefix),
    handler: async (args: string, ctx) => {
      const parsed = parsePlanArgs(args);

      // ── Subcommand: list ─────────────────────────────────────────────────
      if (parsed.subcommand === 'list') {
        const epics = listExistingEpics(ctx.cwd);
        if (epics.length === 0) {
          ctx.ui.notify('No epics found in WorkItems/.', 'info');
          return;
        }
        const lines = epics.map(e =>
          `- **epic-${e.id}** — ${e.title} (${e.workItemCount} work item${e.workItemCount === 1 ? '' : 's'})`,
        );
        postToChat(`📋 **Existing epics**\n\n${lines.join('\n')}`, 'plan-list');
        return;
      }

      // ── Subcommand: show <epic> ──────────────────────────────────────────
      if (parsed.subcommand === 'show') {
        if (!parsed.target) {
          ctx.ui.notify('Usage: /plan show <epic-id>', 'warning');
          return;
        }
        try {
          const epicLoader = new EpicLoader(ctx.cwd);
          const epicPath = epicLoader.findEpic(parsed.target);
          if (!epicPath) {
            ctx.ui.notify(`Epic "${parsed.target}" not found.`, 'warning');
            return;
          }
          const content = fs.readFileSync(epicPath, 'utf-8');
          postToChat(content, 'plan-show');
        } catch (err) {
          ctx.ui.notify(`Failed to read epic: ${(err as Error).message}`, 'error');
        }
        return;
      }

      // ── Subcommand: revise [feedback] ────────────────────────────────────
      // Picks up the last /plan request from .tdd-workflow/planning/_request.json
      // and re-runs in append mode, instructing the planner to incorporate the
      // user's revision feedback. Falls back to ctx.ui.input when no feedback
      // is supplied inline.
      let plannerRequest: string;
      let mode: PlanMode = parsed.replace ? 'replace' : 'append';
      if (parsed.subcommand === 'revise') {
        const prior = readPriorRequest(ctx.cwd);
        if (!prior) {
          ctx.ui.notify(
            'No prior /plan session found in .tdd-workflow/planning/_request.json. Run /plan first, then /plan revise.',
            'warning',
          );
          return;
        }
        let feedback = parsed.rest;
        if (!feedback) {
          feedback = await ctx.ui.input('Describe the revision you want:') || '';
          if (!feedback) return;
        }
        plannerRequest =
          `${prior.request}\n\n` +
          `## Revision request\n` +
          `The user reviewed the previous plan and wants the following changes incorporated:\n\n` +
          `> ${feedback}\n\n` +
          `Update only what's needed. Reuse existing epic slugs to update epics in place; ` +
          `propose new epics only when the revision genuinely adds scope.`;
        mode = 'append';
      } else {
        // ── Default subcommand: new planning run ──────────────────────────
        let requestText = parsed.rest;
        if (!requestText) {
          requestText = await ctx.ui.input('Enter project or feature description:') || '';
          if (!requestText) return;
        }
        if (parsed.fromEpic) {
          try {
            const epicLoader = new EpicLoader(ctx.cwd);
            const epicPath = epicLoader.findEpic(parsed.fromEpic);
            if (epicPath) {
              const epicContent = fs.readFileSync(epicPath, 'utf-8');
              requestText =
                `${requestText}\n\n## Extending existing epic\n` +
                `Build on top of this epic — propose follow-on work items or a new epic ` +
                `that complements it:\n\n${epicContent}`;
            } else {
              ctx.ui.notify(`Epic "${parsed.fromEpic}" not found — proceeding without it.`, 'warning');
            }
          } catch (err) {
            ctx.ui.notify(`Failed to load --from-epic: ${(err as Error).message}`, 'warning');
          }
        }
        if (parsed.brownfield) {
          requestText =
            `${requestText}\n\n## Brownfield context\n` +
            `This is an existing codebase. Explore the repository thoroughly before proposing epics. ` +
            `Prefer epics that integrate with existing modules over greenfield rewrites.`;
        }
        plannerRequest = requestText;
      }

      ctx.ui.notify(`Project Planner starting (${mode} mode)…`, 'info');
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
        const result = await planProject(
          plannerRequest,
          modelRouter,
          ctx.cwd,
          {
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
                '---\n✅ Type **`approve`** to create the WorkItems, or describe what you\'d like changed.\n' +
                '_Tip: if you want changes, type the feedback here, then run `/plan revise` — your original request is already saved._',
                'plan-review-prompt'
              );
              const response = await waitForChatInput();
              if (!response) return null; // cancelled / timed out
              const trimmed = response.trim().toLowerCase();
              if (trimmed === 'approve' || trimmed === 'yes' || trimmed === 'y') {
                return initialText; // approved as-is — project-planner will write files
              }
              // Persist the feedback so /plan revise can pick it up without retyping.
              try {
                const planningDir = path.join(ctx.cwd, '.tdd-workflow', 'planning');
                fs.mkdirSync(planningDir, { recursive: true });
                fs.writeFileSync(
                  path.join(planningDir, '_pending_feedback.txt'),
                  response,
                  'utf-8',
                );
              } catch { /* non-fatal */ }
              postToChat(
                `📝 Got it. Run \`/plan revise\` to apply this feedback (your original request is saved):\n\n> ${response}`,
                'plan-feedback'
              );
              return null;
            },
            // confirm is reached only if editor returned non-null; auto-approve so we
            // don't show a second dialog after the chat-based review above.
            confirm: async (_message: string) => true,
            chatMessage: (content: string) => postToChat(content),
          },
          { mode },
        );

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
        const searxngUrl = getSearxngUrl();
        const searchClient = searxngUrl ? new SearchClient(searxngUrl) : null;

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

  pi.registerCommand('tdd:nudge', {
    description: 'Send an immediate nudge to a silent implementer agent without waiting for the 5-minute idle timer.',
    handler: async (_args: string, ctx) => {
      if (!executor) {
        ctx.ui.notify('No TDD workflow is currently running.', 'warning');
        return;
      }
      executor.nudge();
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
        const searxngUrl = getSearxngUrl();
        const searchClient = searxngUrl ? new SearchClient(searxngUrl) : null;
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
    getArgumentCompletions: (argumentPrefix: string) => completeResearchArgs(process.cwd(), argumentPrefix),
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
      const searxngUrl = getSearxngUrl();
      const searchClient = searxngUrl ? new SearchClient(searxngUrl) : null;

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
        provider: 'local' | 'openrouter' | 'openai';
        ggufFilename?: string;   // local models
        modelId?: string;        // cloud models
        apiKeyEnvVar?: string;   // cloud models
        baseURL?: string;        // set when not on the default provider URL (e.g. vLLM, secondary llama.cpp)
        contextLength?: number;
        maxOutputTokens?: number;
        reasoning?: boolean;
      }

      // ── 1. Resolve primary llamaUrl (written to config as the default base URL) ──
      const existingConfig = isGlobal ? loadGlobalConfig() : loadConfig(ctx.cwd);
      let llamaUrl = process.env['LLAMA_CPP_URL'] || existingConfig?.llamaCppUrl || 'http://localhost:8080/v1';

      const piProviders = readPiLlamaCppProviders();
      if (piProviders.length === 1) {
        llamaUrl = piProviders[0]!.baseUrl;
      } else if (piProviders.length > 1) {
        // Use the first provider as the primary (config default); all are probed below.
        llamaUrl = piProviders[0]!.baseUrl;
      } else if (!process.env['LLAMA_CPP_URL'] && !existingConfig?.llamaCppUrl) {
        const urlInput = await ctx.ui.input(`llama.cpp API URL [${llamaUrl}]:`);
        llamaUrl = urlInput?.trim() || llamaUrl;
      }

      // ── 2. Discover models from ALL Pi llama.cpp providers ───────────
      // Each provider's models are tagged with their source baseUrl so the
      // router can reach the right server even when multiple servers are configured.
      const serversToProbe = piProviders.length > 0
        ? piProviders
        : [{ name: 'local', baseUrl: llamaUrl }];

      const configuredFilenames = new Set(
        Object.values(existingConfig?.models ?? {})
          .filter(p => p.provider === 'local')
          .map(p => p.ggufFilename)
          .filter(Boolean)
      );

      const allDiscovered: Array<{ id: string; serverUrl: string; serverName: string }> = [];
      ctx.ui.setStatus('setup', '🔍 Discovering models...');
      for (const srv of serversToProbe) {
        const cached = readPiCachedModels(srv.baseUrl);
        const ids = cached.length > 0 ? cached : await discoverModels(srv.baseUrl);
        for (const id of ids) allDiscovered.push({ id, serverUrl: srv.baseUrl, serverName: srv.name });
      }
      ctx.ui.setStatus('setup', undefined);

      let localEntries: SetupModelEntry[] = [];
      if (allDiscovered.length === 0) {
        ctx.ui.notify('No models found. Enter model IDs manually.', 'warning');
        const manual = await ctx.ui.input('Model IDs (comma-separated), or leave empty to cancel:');
        if (!manual?.trim()) return;
        localEntries = manual.split(',').map(s => s.trim()).filter(Boolean)
          .map(id => ({ displayName: id, provider: 'local' as const, ggufFilename: id }));
      } else {
        const multiServer = serversToProbe.length > 1;
        const listText = allDiscovered.map((m, i) => {
          const marker = configuredFilenames.has(m.id) ? ' *' : '';
          const tag = multiServer ? `  [${m.serverName}]` : '';
          return `${i + 1}. ${m.id}${tag}${marker}`;
        }).join('\n');
        const note = configuredFilenames.size > 0 ? '  (* = already configured)' : '';
        ctx.ui.notify(`Available models:${note}\n${listText}`, 'info');

        const sel = await ctx.ui.input('Select models to include (e.g. "1,3") or Enter for all:');
        const selected = sel?.trim()
          ? sel.split(',').map(s => parseInt(s.trim(), 10) - 1)
              .filter(i => i >= 0 && i < allDiscovered.length).map(i => allDiscovered[i]!)
          : allDiscovered;
        if (selected.length === 0) {
          ctx.ui.notify('No valid selections. Setup cancelled.', 'warning');
          return;
        }
        localEntries = selected.map(m => ({
          displayName: multiServer ? `${m.id}  [${m.serverName}]` : m.id,
          provider: 'local' as const,
          ggufFilename: m.id,
          // Only set baseURL when the model lives on a non-primary server
          baseURL: m.serverUrl !== llamaUrl ? m.serverUrl : undefined,
        }));
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
          const provider: 'openrouter' | 'openai' =
            cp.baseUrl.includes('openrouter') ? 'openrouter' : 'openai';
          // Endpoints at non-standard URLs (vLLM, self-hosted OpenAI-compatible)
          // need baseURL stored on the profile so the router calls the right server.
          const isWellKnown = cp.baseUrl.includes('openrouter') || cp.baseUrl.includes('openai.com');
          const entryBaseURL = isWellKnown ? undefined : cp.baseUrl;
          for (const m of fetched) {
            cloudEntries.push({
              displayName: `${m.id}  (${Math.round(m.contextLength / 1000)}k ctx)  [${cp.name}]`,
              provider,
              modelId: m.id,
              apiKeyEnvVar,
              baseURL: entryBaseURL,
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

      // Merge cached model info from all probed servers so thinking/context data
      // is available regardless of which server a model lives on.
      const piModelInfo = new Map(serversToProbe.flatMap(srv =>
        [...readPiCachedModelInfo(srv.baseUrl).entries()]
      ));

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
              ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
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
              ...(entry.baseURL ? { baseURL: entry.baseURL } : {}),
              contextWindow: entry.contextLength ?? 128_000,
              maxOutputTokens: entry.maxOutputTokens ?? 32_768,
              architecture: arch,
              speed: arch === 'moe' ? 'fast' : 'slow',
              enableThinking,
            };
          }
        }

        routing[type] = key;

        // sessionRefreshAfter is implement-specific — ask whenever the implement
        // role is assigned (even if the model was already configured for another role).
        if (type === 'implement') {
          const profile = models[key]!;
          const isLocal = profile.provider === 'local';
          const defaultRefresh = profile.sessionRefreshAfter ?? (isLocal ? 2 : 4);
          const refreshInput = await ctx.ui.input(
            `Session refresh interval for "${profile.name}":\n` +
            `  A new session is started every N reviewer rounds to reset the context window.\n` +
            `  Lower = more resets (better for small local context windows).\n` +
            `  Higher = fewer resets (better for frontier models with large context windows).\n` +
            `  0 or blank = never reset.\n\n` +
            `Refresh every N rounds [${defaultRefresh}]:`
          );
          const parsed = parseInt(refreshInput?.trim() || '', 10);
          const refreshAfter = !refreshInput?.trim() ? defaultRefresh
            : (isNaN(parsed) || parsed <= 0) ? Number.MAX_SAFE_INTEGER
            : parsed;
          models[key]!.sessionRefreshAfter = refreshAfter === Number.MAX_SAFE_INTEGER ? undefined : refreshAfter;
        }
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

      // ── 6. Local override warning (global save only) ─────────────────
      if (saveGlobal) {
        const localConfigPath = path.join(ctx.cwd, 'models.config.json');
        if (fs.existsSync(localConfigPath)) {
          ctx.ui.notify(
            `⚠️  A local config exists at ${localConfigPath} and will override the global settings for this project.`,
            'warning'
          );
          const LOCAL_OPT_KEEP   = 'Leave it as-is  (local overrides global for this project)';
          const LOCAL_OPT_UPDATE = 'Update it with these same settings';
          const LOCAL_OPT_REMOVE = 'Remove it  (global config will apply to this project)';
          const localAction = await ctx.ui.select(
            'What would you like to do with the local config?',
            [LOCAL_OPT_KEEP, LOCAL_OPT_UPDATE, LOCAL_OPT_REMOVE]
          );
          if (localAction === LOCAL_OPT_REMOVE) {
            fs.rmSync(localConfigPath);
            ctx.ui.notify(`Removed ${localConfigPath} — global config now applies here.`, 'info');
          } else if (localAction === LOCAL_OPT_UPDATE) {
            saveConfig(finalConfig, ctx.cwd);
            ctx.ui.notify(`Updated ${localConfigPath} to match global settings.`, 'info');
          }
        }
      }

      // ── 7. Summary ───────────────────────────────────────────────────
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

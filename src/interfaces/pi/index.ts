import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { StateManager } from '../../orchestrator/state.js';
import { WorkflowExecutor } from '../../orchestrator/executor.js';
import { ModelRouter } from '../../llm/model-router.js';
import { SearchClient } from '../../search/searxng.js';
import { analyzeProject, isAnalysisStale } from '../../analysis/runner.js';
import { planProject } from '../../agents/project-planner.js';
import { performDeepResearch } from '../../agents/researcher.js';
import { getLogger } from '../../utils/logger.js';
import * as path from 'path';

export default function(pi: ExtensionAPI) {
  let executor: WorkflowExecutor | null = null;
  let stateManager: StateManager | null = null;

  pi.registerCommand('tdd', {
    description: 'Start a new Agentic TDD Epic',
    handler: async (args: string, ctx) => {
      // Lazy init orchestrator state
      if (!stateManager) {
        stateManager = new StateManager(ctx.cwd);
        const modelRouter = new ModelRouter();
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

        executor.events.on('taskFailed', async (data: { id: string, feedback: string, isCircuitBroken: boolean, canRollback?: boolean, originalBranch?: string }) => {
          ctx.ui.notify(`❌ [TDD] Task failed: ${data.id}. Feedback:\n${data.feedback}`, 'error');
          
          if (data.canRollback && data.originalBranch && executor) {
            const shouldRollback = await ctx.ui.confirm(
              'Discard changes and rollback?',
              `The task failed. Do you want to rollback to branch: ${data.originalBranch}? (Default is NO, keeping changes for inspection)`
            );
            if (shouldRollback) {
              await executor.rollbackTask(data.originalBranch);
              ctx.ui.notify(`✅ Rolled back to ${data.originalBranch}`, 'info');
            }
          }

          if (data.isCircuitBroken) {
            ctx.ui.setStatus('tdd', undefined);
            ctx.ui.notify('Circuit breaker tripped. Workflow paused.', 'warning');
          }
        });
      }

      if (!args) {
        args = await ctx.ui.input('Enter TDD Epic description:') || '';
        if (!args) return;
      }

      ctx.ui.notify('TDD Workflow starting in background processing...', 'info');
      stateManager.initWorkflow(args);
      
      // Async start
      executor!.startNew(args).then(() => {
        const summary = stateManager!.getSummary();
        ctx.ui.setStatus('tdd', undefined); // Clear status
        if (summary.pending === 0 && summary.failed === 0) {
          ctx.ui.notify(`🎉 TDD Epic Complete! ${summary.completed} subtasks implemented.`, 'info');
        } else {
          ctx.ui.notify(`⚠️ TDD Epic Paused. ${summary.failed} failed, ${summary.pending} pending.`, 'warning');
        }
      }).catch((err: any) => {
        ctx.ui.setStatus('tdd', undefined);
        ctx.ui.notify(`🔥 TDD Engine Error: ${err.message}`, 'error');
      });
    }
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

        const modelRouter = new ModelRouter();
        if (modelRouter.isPassthrough) {
          ctx.ui.notify(
            "⚠️  No models.config.json found — using Pi's active model for planning.",
            'warning'
          );
        }
        const result = await planProject(args, modelRouter, ctx.cwd, {
          input: async (prompt: string) => {
            const result = await ctx.ui.input(prompt);
            return result ?? null;
          },
          notify: (message: string, type?: 'info' | 'warning' | 'error') => ctx.ui.notify(message, type || 'info'),
          editor: async (label: string, initialText: string) => {
            const result = await ctx.ui.editor(label, initialText);
            return result ?? null;
          },
          confirm: async (message: string) => {
            return await ctx.ui.confirm(message, 'This will create files in WorkItems/');
          },
        });
        
        ctx.ui.setStatus('plan', undefined);
        ctx.ui.notify(result.summary, 'info');

      } catch (err) {
        ctx.ui.setStatus('plan', undefined);
        const e = err as Error;
        ctx.ui.notify(`Planning failed: ${e.message}`, 'error');
      }
    }
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
    description: 'Launch a Deep Research Agent to browse the web and distill knowledge',
    handler: async (args: string, ctx) => {
      // Parse background flag
      let isBackground = false;
      let topic = args.trim();
      
      const bgMatch = topic.match(/\s+(--bg|--background)$/i);
      if (bgMatch) {
        isBackground = true;
        topic = topic.replace(bgMatch[0], '').trim();
      }

      if (!topic) {
        topic = await ctx.ui.input('Enter research topic or query (append --bg for background):') || '';
        if (!topic) return;
        
        const lateBgMatch = topic.match(/\s+(--bg|--background)$/i);
        if (lateBgMatch) {
          isBackground = true;
          topic = topic.replace(lateBgMatch[0], '').trim();
        }
      }

      const modelRouter = new ModelRouter();
      if (modelRouter.isPassthrough) {
        ctx.ui.notify(
          "⚠️  No models.config.json found — using Pi's active model for research.",
          'warning'
        );
      }
      const searchClient = process.env.SEARXNG_URL ? new SearchClient(process.env.SEARXNG_URL) : null;

      await performDeepResearch(topic, ctx.cwd, modelRouter, searchClient, {
        background: isBackground,
        uiContext: ctx.ui
      });
    }
  });

  pi.on('session_shutdown', async () => {
    if (executor) {
      if ((executor as any).searchClient?.mcpPool) {
        await (executor as any).searchClient.mcpPool.disconnect();
      }
    }
  });
}

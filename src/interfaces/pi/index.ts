import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { StateManager } from '../../orchestrator/state.js';
import { WorkflowExecutor } from '../../orchestrator/executor.js';
import { LLMClient } from '../../llm/client.js';
import { SearchClient } from '../../search/searxng.js';
import { analyzeProject } from '../../analysis/runner.js';
import { getLogger } from '../../utils/logger.js';
import { MCPClientPool } from '../../mcp/client-pool.js';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export default function(pi: ExtensionAPI) {
  let executor: WorkflowExecutor | null = null;
  let stateManager: StateManager | null = null;

  pi.registerCommand('tdd', {
    description: 'Start a new Agentic TDD Epic',
    handler: async (args: string, ctx) => {
      // Lazy init orchestrator state
      if (!stateManager) {
        stateManager = new StateManager(ctx.cwd);
        const llmClient = new LLMClient();
        let mcpPool: MCPClientPool | null = null;
        const mcpConfigPath = path.join(os.homedir(), '.pi', 'agent', 'mcp.json');
        if (fs.existsSync(mcpConfigPath)) {
          mcpPool = await MCPClientPool.fromPiConfig(mcpConfigPath);
        }

        const searchClient = process.env.SEARXNG_URL ? new SearchClient(process.env.SEARXNG_URL, mcpPool || undefined) : null;

        executor = new WorkflowExecutor(stateManager, llmClient, {
          searchClient,
          mcpPool,
        });

        // Bind UI events
        executor.events.on('taskStarted', (data) => {
          ctx.ui.setStatus('tdd', `⚙️  [TDD] Starting: ${data.description.substring(0, 30)}...`);
        });

        executor.events.on('taskProgress', (data) => {
          ctx.ui.setStatus('tdd', `⚙️  [TDD] Attempt ${data.attempt}: ${data.message}`);
        });

        executor.events.on('taskCompleted', async (data) => {
          ctx.ui.notify(`✅ [TDD] Task completed: ${data.id}`, 'info');
          if (mcpPool?.hasServer('context-mode')) {
            const files = data.task?.files_changed || [];
            await mcpPool.callTool('context-mode', 'ctx_index', {
              content: `## TDD Task Completed: ${data.task?.description || data.id}\n` +
                       `Status: Success\n`,
              title: `TDD: ${(data.task?.description || data.id).substring(0, 50)}`
            }).catch(e => getLogger().warn(`Failed to notify context-mode: ${e.message}`));
          }
        });

        executor.events.on('taskFailed', (data) => {
          ctx.ui.notify(`❌ [TDD] Task failed: ${data.id}. Feedback:\n${data.feedback}`, 'error');
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

  pi.on('session_shutdown', async () => {
    if (executor && (executor as any).mcpPool) {
      await (executor as any).mcpPool.disconnect();
    }
  });
}

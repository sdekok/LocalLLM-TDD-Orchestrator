import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StateManager } from '../../orchestrator/state.js';
import { WorkflowExecutor } from '../../orchestrator/executor.js';
import { LLMClient } from '../../llm/client.js';
import { SearchClient } from '../../search/searxng.js';
import { analyzeProject, loadCachedAnalysis, isAnalysisStale } from '../../analysis/runner.js';
import { formatMultiAnalysisForPrompt } from '../../analysis/types.js';
import { getLogger } from '../../utils/logger.js';

import { MCPClientPool } from '../../mcp/client-pool.js';

const server = new Server(
  { name: 'tdd-agentic-workflow', version: '2.1.0' },
  { capabilities: { tools: {} } }
);

// Lazy-initialized per project
const executors = new Map<string, { state: StateManager; executor: WorkflowExecutor }>();
// Share one pool for the MCP server process
let globalMcpPool: MCPClientPool | null = null;
let mcpPoolInitPromise: Promise<void> | null = null;

async function initGlobalMcpPool(projectDir: string) {
  if (!globalMcpPool) {
    globalMcpPool = await MCPClientPool.fromProjectConfig(projectDir);
  }
}

async function getOrCreate(projectDir: string) {
  if (!mcpPoolInitPromise) {
    mcpPoolInitPromise = initGlobalMcpPool(projectDir);
  }
  await mcpPoolInitPromise;

  if (!executors.has(projectDir)) {
    const state = new StateManager(projectDir);
    const llm = new LLMClient();
    const searchClient = new SearchClient(undefined, globalMcpPool || undefined);
    const executor = new WorkflowExecutor(state, llm, {
      searchClient,
      mcpPool: globalMcpPool,
    });
    executors.set(projectDir, { state, executor });
  }
  return executors.get(projectDir)!;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'start_tdd_workflow',
      description: 'Start a background agentic TDD workflow to implement a user request.',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'The feature or task description to implement.' },
          projectDir: { type: 'string', description: 'Absolute path to the project root directory.' },
        },
        required: ['request', 'projectDir'],
      },
    },
    {
      name: 'resume_tdd_workflow',
      description: 'Resume a previously started TDD workflow from where it left off.',
      inputSchema: {
        type: 'object',
        properties: {
          projectDir: { type: 'string', description: 'Absolute path to the project root directory.' },
          retryFailed: {
            type: 'boolean',
            description: 'If true, also retry tasks that previously failed after 3 attempts.',
          },
        },
        required: ['projectDir'],
      },
    },
    {
      name: 'check_workflow_status',
      description: 'Retrieve the current status of all subtasks in the workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          projectDir: { type: 'string', description: 'Absolute path to the project root directory.' },
        },
        required: ['projectDir'],
      },
    },
    {
      name: 'analyze_project',
      description:
        'Run code analysis on a project: dependency graph, export map, pattern detection, circular deps, test coverage mapping. ' +
        'Optionally generates LLM-powered architecture documentation. Results are cached and reused by the TDD workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          projectDir: { type: 'string', description: 'Absolute path to the project root directory.' },
          generateDocs: {
            type: 'boolean',
            description: 'If true, also generates LLM-powered architecture documentation.',
          },
          forceRefresh: {
            type: 'boolean',
            description: 'If true, re-runs analysis even if cached results exist.',
          },
        },
        required: ['projectDir'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments as Record<string, unknown>;
  const toolName = request.params.name;

  if (toolName === 'start_tdd_workflow') {
    const projectDir = args.projectDir as string;
    const userRequest = args.request as string;
    const { executor } = await getOrCreate(projectDir);

    // Fire-and-forget — the workflow runs in the background
    executor.startNew(userRequest).catch((err: unknown) => {
      getLogger().error(`Workflow failed: ${err}`);
    });

    return {
      content: [
        {
          type: 'text',
          text: `Workflow started for project: ${projectDir}\nRequest: ${userRequest}\nUse check_workflow_status to monitor progress.`,
        },
      ],
    };
  }

  if (toolName === 'resume_tdd_workflow') {
    const projectDir = args.projectDir as string;
    const retryFailed = (args.retryFailed as boolean) || false;
    const { executor } = await getOrCreate(projectDir);

    executor.resume(retryFailed).catch((err: unknown) => {
      getLogger().error(`Resume failed: ${err}`);
    });

    return {
      content: [
        {
          type: 'text',
          text: `Workflow resumed for project: ${projectDir} (retryFailed: ${retryFailed})`,
        },
      ],
    };
  }

  if (toolName === 'check_workflow_status') {
    const projectDir = args.projectDir as string;
    const { state } = await getOrCreate(projectDir);
    const summary = state.getSummary();
    const fullState = state.getState();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              summary,
              refinedRequest: fullState.refined_request,
              subtasks: fullState.subtasks.map((t) => ({
                id: t.id,
                description: t.description.substring(0, 100),
                status: t.status,
                attempts: t.attempts,
                feedback: t.feedback?.substring(0, 200),
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (toolName === 'analyze_project') {
    const projectDir = args.projectDir as string;
    const generateDocs = (args.generateDocs as boolean) || false;
    const forceRefresh = (args.forceRefresh as boolean) || false;

    // Check cache first
    if (!forceRefresh) {
      const cached = loadCachedAnalysis(projectDir);
      if (cached && !isAnalysisStale(projectDir)) {
        const summary = formatMultiAnalysisForPrompt(cached);
        return {
          content: [
            {
              type: 'text',
              text: `Analysis loaded from cache (use forceRefresh=true to re-analyze).\n\n${summary}`,
            },
          ],
        };
      }
    }

    try {
      const llm = generateDocs ? new LLMClient() : undefined;
      const { results, docsPath } = await analyzeProject(projectDir, {
        generateDocs,
        llm,
      });

      const summary = formatMultiAnalysisForPrompt(results);
      const docsNote = docsPath ? `\nArchitecture docs written to: ${docsPath}` : '';

      return {
        content: [
          {
            type: 'text',
            text: `Analysis complete.${docsNote}\n\n${summary}`,
          },
        ],
      };
    } catch (err: unknown) {
      return {
        content: [
          {
            type: 'text',
            text: `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${toolName}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Use stderr — stdout is the MCP transport
  process.stderr.write('[tdd-workflow] MCP server running on stdio\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`[tdd-workflow] Server error: ${error}\n`);
  process.exit(1);
});

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
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

const server = new Server(
  { name: 'tdd-agentic-workflow', version: '2.1.0' },
  { capabilities: { tools: {} } }
);

// Lazy-initialized per project
const executors = new Map<string, { state: StateManager; executor: WorkflowExecutor; llm: LLMClient }>();

/** File/directory names that indicate a valid project root. */
const PROJECT_MARKERS = [
  'package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod',
  'pyproject.toml', 'setup.py', 'CMakeLists.txt', '.git',
];

function resolveProjectDir(projectDirArg: string): string {
  let resolved = projectDirArg;
  if (resolved.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    resolved = path.join(home, resolved.slice(1));
  }
  resolved = path.resolve(resolved);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }

  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolved}`);
  }

  const hasMarker = PROJECT_MARKERS.some((m) => fs.existsSync(path.join(resolved, m)));
  if (!hasMarker) {
    throw new Error(
      `"${resolved}" does not appear to be a project directory. ` +
      `Expected at least one of: ${PROJECT_MARKERS.join(', ')}`
    );
  }

  return resolved;
}

const MAX_CACHED_EXECUTORS = 10;

async function getOrCreate(projectDir: string) {
  if (!executors.has(projectDir)) {
    const state = new StateManager(projectDir);
    const llm = new LLMClient();
    const searchClient = new SearchClient(undefined);
    const executor = new WorkflowExecutor(state, llm.router, {
      searchClient,
    });
    if (executors.size >= MAX_CACHED_EXECUTORS) {
      const oldest = executors.keys().next().value!;
      executors.delete(oldest);
    }
    executors.set(projectDir, { state, executor, llm });
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
          mode: {
            type: 'string',
            enum: ['skip', 'retry', 'resume'],
            description: '"resume" keeps reviewer feedback from prior run (recommended). "retry" wipes feedback and starts fresh. "skip" skips failed tasks and continues with pending ones.',
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
    const projectDir = resolveProjectDir(args.projectDir as string);
    const userRequest = args.request as string;
    const { executor } = await getOrCreate(projectDir);

    const workflowId = randomUUID();
    executor.startNew(userRequest).catch((err: unknown) => {
      getLogger().error(`Workflow ${workflowId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return {
      content: [
        {
          type: 'text',
          text: `Workflow started (id: ${workflowId})\nProject: ${projectDir}\nRequest: ${userRequest}\nUse check_workflow_status to monitor progress. If the workflow fails, search logs for "${workflowId}".`,
        },
      ],
    };
  }

  if (toolName === 'resume_tdd_workflow') {
    const projectDir = resolveProjectDir(args.projectDir as string);
    const mode = (args.mode as 'skip' | 'retry' | 'resume') || 'skip';
    const { executor } = await getOrCreate(projectDir);

    const resumeId = randomUUID();
    executor.resume(mode).catch((err: unknown) => {
      getLogger().error(`Resume ${resumeId} failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return {
      content: [
        {
          type: 'text',
          text: `Workflow resumed (id: ${resumeId})\nProject: ${projectDir} (mode: ${mode})\nUse check_workflow_status to monitor progress.`,
        },
      ],
    };
  }

  if (toolName === 'check_workflow_status') {
    const projectDir = resolveProjectDir(args.projectDir as string);
    const { state, llm } = await getOrCreate(projectDir);
    const summary = state.getSummary();
    const fullState = state.getState();
    const modelConfig = llm.getRoutingConfig();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              summary,
              refinedRequest: fullState.refined_request,
              modelConfig,
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
    const projectDir = resolveProjectDir(args.projectDir as string);
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
            text: `Analysis failed for ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
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

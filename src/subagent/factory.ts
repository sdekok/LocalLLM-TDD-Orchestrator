import {
  createAgentSession,
  SessionManager,
  createCodingTools,
  createReadOnlyTools,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  DefaultResourceLoader,
  type AgentSession,
  type ToolDefinition,
  type ExtensionContext,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionFactory,
} from '@mariozechner/pi-coding-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { ModelRouter, type TaskType, type ModelProfile } from '../llm/model-router.js';
import { getLogger } from '../utils/logger.js';
import { getAskUserForClarificationParams, type AskUserForClarificationArgs } from './tools.js';

const PI_AGENT_DIR = path.join(os.homedir(), '.pi', 'agent');

/**
 * Resolve Pi extension package paths from ~/.pi/agent/settings.json so the
 * subagent session loads the same extensions as the main Pi session (including
 * pi-mcp-adapter, which starts the MCP servers like context-mode).
 */
function resolveAgentExtensionPaths(agentDir: string): string[] {
  const settingsPath = path.join(agentDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return [];

  let packages: string[] = [];
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { packages?: string[] };
    packages = settings.packages ?? [];
  } catch {
    return [];
  }

  const logger = getLogger();
  const resolved: string[] = [];
  // Require resolver rooted at the agent dir so npm: packages are found via Node resolution
  const agentRequire = createRequire(path.join(agentDir, '__placeholder__.js'));

  for (const pkg of packages) {
    if (pkg.startsWith('npm:')) {
      const pkgName = pkg.slice(4);
      // Try Node module resolution first (handles local + hoisted installs)
      try {
        const pkgJsonPath = agentRequire.resolve(`${pkgName}/package.json`);
        resolved.push(path.dirname(pkgJsonPath));
        continue;
      } catch {/* fall through to global search */}

      // Fall back to common npm global prefix locations
      const npmGlobalCandidates = [
        path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', pkgName),
        '/usr/local/lib/node_modules/' + pkgName,
        '/usr/lib/node_modules/' + pkgName,
      ];
      const found = npmGlobalCandidates.find(p => fs.existsSync(path.join(p, 'package.json')));
      if (found) {
        resolved.push(found);
      } else {
        logger.warn(`[SUBAGENT FACTORY] Could not resolve extension package: ${pkg}`);
      }
    } else if (pkg.startsWith('git:')) {
      // git: packages are cached under agentDir/git/<host>/<user>/<repo>/...
      const gitPath = path.join(agentDir, 'git', pkg.slice(4));
      if (fs.existsSync(gitPath)) resolved.push(gitPath);
    } else {
      // Relative or absolute filesystem path
      const absPath = path.isAbsolute(pkg) ? pkg : path.resolve(agentDir, pkg);
      if (fs.existsSync(absPath)) resolved.push(absPath);
    }
  }

  logger.info(`[SUBAGENT FACTORY] Resolved ${resolved.length}/${packages.length} agent extensions`);
  return resolved;
}

export interface SubAgentOptions {
  taskType: TaskType;
  systemPrompt: string;
  cwd: string;
  modelRouter: ModelRouter;
  feedback?: string;
  /** Task metadata from Epic/WorkItem — populates system prompt placeholders */
  taskMetadata?: {
    acceptance?: string[];
    security?: string;
    tests?: string[];
    devNotes?: string;
  };
  tools?: 'coding' | 'review' | 'readonly' | 'none';
  // Optional: UI context for interactive tools (e.g., ask_user_for_clarification)
  uiContext?: {
    input: (prompt: string) => Promise<string | null>;
    notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  };
  customTools?: ToolDefinition[];
}

/**
 * Factory for spawning ephemeral Pi sub-agent sessions.
 */
export async function createSubAgentSession(options: SubAgentOptions): Promise<AgentSession> {
  const logger = getLogger();
  const profile = options.modelRouter.selectModel(options.taskType);
  logger.info(`[SUBAGENT FACTORY] Selected model for ${options.taskType}: ${profile.modelId || profile.ggufFilename}`);
  logger.info(`[SUBAGENT FACTORY] Model provider: ${profile.provider}, Thinking enabled: ${profile.enableThinking}`);

  // Inject feedback Context if provided
  const feedbackContext = options.feedback
    ? `\n\nPREVIOUS ATTEMPT FAILED. Feedback for this attempt:\n${options.feedback}\n\nFix these issues.`
    : '';
  
  const finalPrompt = options.systemPrompt.replace('{feedbackContext}', feedbackContext);

  // Populate task metadata placeholders from Epic/WorkItem context
  const meta = options.taskMetadata;
  const populatedPrompt = finalPrompt
    .replace('{acceptance}', meta?.acceptance?.length ? meta.acceptance.map(a => `- ${a}`).join('\n') : 'None specified')
    .replace('{security}', meta?.security || 'None specified')
    .replace('{tests}', meta?.tests?.length ? meta.tests.map(t => `- ${t}`).join('\n') : 'None specified')
    .replace('{devNotes}', meta?.devNotes || 'None specified');

  const targetModelId = profile.modelId || profile.ggufFilename;
  logger.info(`Spawning sub-agent [${options.taskType}] with target model: ${targetModelId}`);
  // Rough token estimate for context budget monitoring (1 token ≈ 4 chars for English)
  const estimatedTokens = Math.ceil(populatedPrompt.length / 4);
  logger.info(`[SUBAGENT FACTORY] System prompt: ~${estimatedTokens} tokens (${populatedPrompt.length} chars)`);
  logger.info(`[SUBAGENT FACTORY] System prompt preview: ${populatedPrompt.substring(0, 200)}...`);

  // Build the tools list
  let baseTools: any[];
  if (options.tools === 'none') {
    baseTools = [];
  } else if (options.tools === 'readonly') {
    baseTools = createReadOnlyTools(options.cwd);
  } else if (options.tools === 'review') {
    // Reviewer: read-only tools + bash for running tests/inspecting, but no write/edit
    baseTools = [...createReadOnlyTools(options.cwd), createBashTool(options.cwd)];
  } else {
    // Coding: full editing tools + search tools for code navigation
    baseTools = [...createCodingTools(options.cwd), createGrepTool(options.cwd), createFindTool(options.cwd), createLsTool(options.cwd)];
  }

  logger.info(`[SUBAGENT FACTORY] Tools loaded: ${options.tools || 'coding'}`);
  logger.info(`[SUBAGENT FACTORY] Final prompt (first 500 chars):\n${populatedPrompt.substring(0, 500)}...`);

  // Add custom tools if uiContext is provided (for interactive planning)
  let customTools: ToolDefinition[] | undefined;
  if (options.uiContext && options.taskType === 'project-plan') {
    // Register the ask_user_for_clarification tool
    const clarifToolParams = getAskUserForClarificationParams();
    const toolDef: ToolDefinition = {
      name: 'ask_user_for_clarification',
      label: 'Ask User for Clarification',
      description: 'Ask the user for clarification when you encounter ambiguity, conflicting requirements, or need more information to proceed with planning. This will pause the session and wait for user input.',
      parameters: clarifToolParams,
      execute: async (toolCallId: string, params: AskUserForClarificationArgs, signal, onUpdate, ctx: ExtensionContext) => {
        const question = params.question;
        options.uiContext!.notify('The planner has a question for you...', 'info');
        const answer = await options.uiContext!.input(question);
        const response = answer === null ? 'The user did not provide an answer.' : `User response: ${answer}`;
        return {
          content: [{ type: 'text', text: response }],
          details: { question, answer: response },
        };
      },
    };
    customTools = [toolDef];
  }
  
  if (options.customTools) {
    customTools = [...(customTools || []), ...options.customTools];
  }

  // Load the same extensions Pi itself uses (pi-lens, pi-mcp-adapter, etc.)
  // so MCP servers like context-mode are available in the subagent session.
  const extensionPaths = resolveAgentExtensionPaths(PI_AGENT_DIR);

  // When thinking mode is active, register an extension that strips thinking
  // blocks from prior assistant messages. Keeping only the final visible answer
  // in multi-turn history prevents thinking quality degradation on subsequent turns.
  const extensionFactories: ExtensionFactory[] = [];
  if (profile.enableThinking) {
    extensionFactories.push(createThinkingFilter());
    logger.info('[SUBAGENT FACTORY] Registered thinking-filter extension');
  }

  const loader = new DefaultResourceLoader({
    additionalExtensionPaths: extensionPaths,
    extensionFactories,
    systemPromptOverride: () => populatedPrompt,
    appendSystemPromptOverride: () => [],
    noExtensions: false,
    noSkills: false,
  });
  await loader.reload();

  // Create the ephemeral session without specifying the model.
  // Pi will fall back to its default (potentially wrong provider like openrouter).
  // We correct the model below once extensions have registered their models.
  logger.info(`[SUBAGENT FACTORY] Creating agent session (model will be resolved after extension binding)`);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    sessionManager: SessionManager.inMemory(), // Ephemeral session
    resourceLoader: loader,
    tools: baseTools,
    customTools,
  });

  // Give async extensions (like pi-mcp-adapter, llama-cpp connector) time to:
  //   1. Establish MCP/RPC connections (context-mode MCP server needs to spawn + enumerate tools)
  //   2. Register their providers (e.g. llama-cpp → session.modelRegistry via pi.registerProvider)
  // Default 5 s — override with TDD_MCP_STARTUP_MS if your machine needs more (or less).
  const mcpStartupMs = parseInt(process.env['TDD_MCP_STARTUP_MS'] ?? '5000', 10);
  await new Promise(resolve => setTimeout(resolve, mcpStartupMs));

  // Log available tools for diagnostics
  try {
    const toolInfos = session.getAllTools() as Array<{ name: string }>;
    const toolNames = toolInfos.map((t) => t.name).filter(Boolean);
    logger.info(`[SUBAGENT FACTORY] Available tools: ${toolNames.join(', ') || '(none detected)'}`);
  } catch {
    logger.info(`[SUBAGENT FACTORY] Could not enumerate session tools`);
  }

  // Resolve the correct model now that extensions have registered theirs.
  // The profile's ggufFilename/modelId is the model ID registered by the llama-cpp connector
  // (or the built-in ID for cloud providers). We look it up in the full registry so we get a
  // fully populated Model<TApi> object (with api, baseUrl, etc.) rather than a partial stub.
  if (targetModelId) {
    const allModels = session.modelRegistry.getAll();
    const targetModel = allModels.find((m) => m.id === targetModelId);
    if (targetModel) {
      // Set the model directly on agent state to avoid the side-effect in session.setModel()
      // which persists to ~/.pi/agent/settings.json — undesirable for ephemeral subagents.
      (session as any).agent.state.model = targetModel;
      logger.info(`[SUBAGENT FACTORY] Model set to: ${targetModel.provider}/${targetModel.id}`);
    } else {
      const availableIds = allModels.map((m) => `${m.provider}/${m.id}`).slice(0, 10).join(', ');
      logger.warn(`[SUBAGENT FACTORY] Target model '${targetModelId}' not found in registry after extension binding. Available (first 10): ${availableIds}`);
      logger.warn(`[SUBAGENT FACTORY] Using Pi's fallback model: ${session.model?.provider}/${session.model?.id}`);
    }
  } else {
    // Passthrough mode (no models.config.json) — use whatever Pi selected
    logger.info(`[SUBAGENT FACTORY] Passthrough mode, using Pi's default model: ${session.model?.provider}/${session.model?.id}`);
  }

  // Set thinking level after the model is resolved (model.reasoning gates whether thinking is on).
  const thinkingLevel = profile.enableThinking ? 'medium' : 'off';
  session.setThinkingLevel(thinkingLevel as any);

  logger.info(`[SUBAGENT FACTORY] Agent session created successfully`);
  logger.info(`[SUBAGENT FACTORY] Thinking level: ${thinkingLevel}`);
  logger.info(`[SUBAGENT FACTORY] Session setup complete`);
  return session;
}

/**
 * Strips `thinking` content blocks from prior assistant messages,
 * preserving thinking only in the most recent assistant message.
 *
 * Google recommends that for Gemma 4 multi-turn, you "only keep the final
 * visible answer" in history — thought channel blocks in earlier turns
 * degrade thinking quality in subsequent turns.
 */
export function stripThinkingFromHistory(messages: any[]): any[] {
  // Find the last assistant message index so we can preserve its thinking
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && 'role' in m && (m as any).role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    // Only strip thinking from assistant messages that aren't the most recent
    if (
      idx !== lastAssistantIdx &&
      'role' in msg &&
      (msg as any).role === 'assistant' &&
      Array.isArray((msg as any).content)
    ) {
      const content = (msg as any).content.filter(
        (block: any) => block.type !== 'thinking'
      );
      return { ...msg, content };
    }
    return msg;
  });
}

/** Wraps stripThinkingFromHistory as a Pi SDK extension factory. */
function createThinkingFilter(): ExtensionFactory {
  return (pi) => {
    pi.on('context', (event) => {
      return { messages: stripThinkingFromHistory(event.messages) };
    });
  };
}

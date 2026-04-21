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

// ─── Live session registry ──────────────────────────────────────────────────
//
// Sub-agent sessions hold resources outside the Node process (llama.cpp slots,
// MCP child processes, open file descriptors). If the orchestrator is killed
// mid-workflow — Ctrl-C, SIGTERM from the IDE, unhandled rejection — those
// resources can remain occupied, which is the root cause of "slot stuck" and
// MCP warm-up flakiness the next time a session is created.
//
// We keep a module-level set of every session we hand out and register a
// best-effort shutdown handler that disposes them all. The handler is attached
// exactly once, regardless of how many sub-agent sessions get created.

const ACTIVE_SESSIONS = new Set<AgentSession>();
let shutdownHandlerInstalled = false;

function installShutdownHandler(): void {
  if (shutdownHandlerInstalled) return;
  shutdownHandlerInstalled = true;

  const disposeAll = (reason: string) => {
    if (ACTIVE_SESSIONS.size === 0) return;
    const logger = getLogger();
    logger.warn(`[SUBAGENT FACTORY] Shutdown (${reason}) — disposing ${ACTIVE_SESSIONS.size} active session(s)`);
    for (const session of ACTIVE_SESSIONS) {
      try { session.dispose(); } catch { /* best-effort */ }
    }
    ACTIVE_SESSIONS.clear();
  };

  // Signals: let the default behaviour run AFTER we clean up. We attach with
  // `once` so repeated Ctrl-C doesn't re-trigger disposal; the second signal
  // will kill the process via Node's default handler.
  process.once('SIGINT', () => { disposeAll('SIGINT'); process.exit(130); });
  process.once('SIGTERM', () => { disposeAll('SIGTERM'); process.exit(143); });

  // beforeExit fires when the event loop is empty — a natural termination path.
  // exit() is last-ditch; dispose is synchronous but we do it anyway.
  process.once('beforeExit', () => disposeAll('beforeExit'));
  process.once('exit', () => disposeAll('exit'));

  // Unhandled errors: dispose before Node's default crash, so the operator
  // doesn't have to hunt for zombie llama.cpp slots after a bug.
  process.once('uncaughtException', (err) => {
    disposeAll('uncaughtException');
    // Rethrow so Node's default handler still prints + exits.
    throw err;
  });
  process.once('unhandledRejection', (reason) => {
    disposeAll('unhandledRejection');
    // Node's default is to warn-then-exit (since Node 15); we let that run.
    getLogger().error(`[SUBAGENT FACTORY] unhandledRejection: ${reason}`);
  });
}

/**
 * Wrap a session so that calling `.dispose()` (from any call site) also
 * unregisters it from the live set. Returns the same session object — the
 * wrapping is applied in-place by replacing `dispose`.
 */
function trackSession(session: AgentSession): AgentSession {
  installShutdownHandler();
  ACTIVE_SESSIONS.add(session);

  const originalDispose = session.dispose.bind(session);
  (session as any).dispose = () => {
    ACTIVE_SESSIONS.delete(session);
    return originalDispose();
  };
  return session;
}

/** Test / diagnostic helper. Returns the number of sessions currently registered. */
export function _activeSessionCount(): number {
  return ACTIVE_SESSIONS.size;
}

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
    testCommand?: string;
    packageManager?: string;
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

  // Detect which optional Pi extensions the subagent will have access to,
  // so the prompt doesn't promise tools the session can't actually call.
  // We check the configured extension packages before session creation so
  // the guidance is baked into the system prompt (which Pi caches at session
  // init time and does not re-read later).
  const extensionPaths = resolveAgentExtensionPaths(PI_AGENT_DIR);
  const extHay = extensionPaths.join('|').toLowerCase();
  const hasContextMode = extHay.includes('context-mode') || extHay.includes('pi-mcp-adapter');
  const hasLens = extHay.includes('pi-lens');
  const hasWebSearch = !!process.env['SEARXNG_URL'];

  const toolsGuidance = hasContextMode
    ? `## Context Mode (MANDATORY)

Default to context-mode for ALL commands. Only use Bash for guaranteed-small-output operations.

### Bash Whitelist (Safe to run directly)
- **File mutations**: \`mkdir\`, \`mv\`, \`cp\`, \`rm\`, \`touch\`, \`chmod\`
- **Git writes**: \`git add\`, \`git commit\` — these are the only git operations you are permitted to run
- **Navigation**: \`cd\`, \`pwd\`, \`which\`
- **Process control**: \`kill\`, \`pkill\`
- **Package management**: \`{packageManager} install\`, \`{packageManager} publish\`, \`pip install\`
- **Simple output**: \`echo\`, \`printf\`

**Everything else → \`ctx_execute\` or \`ctx_execute_file\`.**

### Critical Anti-Patterns to Avoid
- **DO NOT** \`cat\` large files via Bash. Use \`ctx_execute_file\`.
- **DO NOT** use \`head\` or \`tail\` via Bash to "save" context; you lose data. Use code in \`ctx_execute\` to process the full dataset and print a summary.`
    : `## Command Execution

This session does NOT have the context-mode MCP tools (\`ctx_execute\`, \`ctx_execute_file\`). Use \`bash\` to run commands directly. Keep command output small:

- When a command might produce a lot of output, pipe through a summary (e.g. \`grep\`, \`awk\`, \`head\`) — but always prefer narrow, targeted commands over large greps.
- For reading files, use \`read\` rather than \`cat\`.
- For file mutations, use \`write\` or \`edit\` rather than shell redirects.
- **Git writes** (\`git add\`, \`git commit\`) are allowed. **Do NOT** run \`git merge\`, \`git push\`, \`git checkout <other>\`, or \`git branch -d\`.`;

  const runCommandGuidance = hasContextMode
    ? `**Running commands**: Prefer \`ctx_execute('{testCommand}')\` for test runs and long-output commands. Use \`bash\` only for short, whitelisted operations.`
    : `**Running commands**: Use the \`bash\` tool for command execution (including \`{testCommand}\`). There is no \`ctx_execute\` tool in this session.`;

  logger.info(`[SUBAGENT FACTORY] Tool detection: contextMode=${hasContextMode}, lens=${hasLens}, webSearch=${hasWebSearch}`);

  // Populate task metadata placeholders from Epic/WorkItem context
  const meta = options.taskMetadata;
  const populatedPrompt = finalPrompt
    .replace(/{toolsGuidance}/g, toolsGuidance)
    .replace(/{runCommandGuidance}/g, runCommandGuidance)
    .replace(/{acceptance}/g, meta?.acceptance?.length ? meta.acceptance.map(a => `- ${a}`).join('\n') : 'None specified')
    .replace(/{security}/g, meta?.security || 'None specified')
    .replace(/{tests}/g, meta?.tests?.length ? meta.tests.map(t => `- ${t}`).join('\n') : 'None specified')
    .replace(/{devNotes}/g, meta?.devNotes || 'None specified')
    .replace(/{testCommand}/g, meta?.testCommand || 'npm test')
    .replace(/{packageManager}/g, meta?.packageManager || 'npm');

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

  // extensionPaths was resolved earlier (we needed it for tool-guidance detection)
  // and is reused here to register the same extensions Pi itself uses (pi-lens,
  // pi-mcp-adapter, etc.) so MCP servers like context-mode are available in
  // the subagent session.

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

  // Register the session for emergency shutdown cleanup. This wraps dispose()
  // so every existing call site automatically unregisters on normal disposal.
  return trackSession(session);
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

import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  type AgentSession,
  type ToolDefinition,
  type ExtensionContext,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionFactory,
  type ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { ModelRouter, type TaskType, type ModelProfile } from '../llm/model-router.js';
import { getLogger } from '../utils/logger.js';
import { getSearxngUrl } from '../search/searxng.js';
import { getAskUserForClarificationParams, type AskUserForClarificationArgs } from './tools.js';
import { ensureModelInPiProvider } from '../interfaces/pi/pi-models.js';

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
    /** When set, the implementer is instructed to verify with this coverage command as its final step. */
    coverageCommand?: string;
  };
  tools?: 'coding' | 'review' | 'readonly' | 'none';
  // Optional: UI context for interactive tools (e.g., ask_user_for_clarification)
  uiContext?: {
    input: (prompt: string) => Promise<string | null>;
    notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  };
  customTools?: ToolDefinition[];
  /**
   * Optional UI notifier. Surfaces model-resolution warnings — notably when the
   * configured model can't be found and the session falls back to Pi's default
   * (or to no model at all) — to the user's chat instead of only the log.
   */
  notify?: (message: string, level?: 'info' | 'warning' | 'error') => void;
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
  // Detect SearXNG from the MCP config (single source of truth) so sub-agents
  // get the searxng_web_search/web_url_read tools allowlisted whenever the
  // searxng MCP server is configured — not only when a separate SEARXNG_URL
  // env var happens to be set in the plugin's process.
  const hasWebSearch = !!getSearxngUrl(PI_AGENT_DIR);

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
    .replace(/{packageManager}/g, meta?.packageManager || 'npm')
    .replace(/{coverageVerification}/g, meta?.coverageCommand
      ? `**Coverage Verification (required for this task)**: This task is focused on improving test coverage. After all tests pass, run \`${meta.coverageCommand}\` as your final step and confirm coverage has improved for the files you modified. Include the before/after coverage numbers in your \`DONE:\` message.`
      : '');

  const targetModelId = profile.modelId || profile.ggufFilename;
  logger.info(`Spawning sub-agent [${options.taskType}] with target model: ${targetModelId}`);
  // Rough token estimate for context budget monitoring (1 token ≈ 4 chars for English)
  const estimatedTokens = Math.ceil(populatedPrompt.length / 4);
  logger.info(`[SUBAGENT FACTORY] System prompt: ~${estimatedTokens} tokens (${populatedPrompt.length} chars)`);
  logger.info(`[SUBAGENT FACTORY] System prompt preview: ${populatedPrompt.substring(0, 200)}...`);

  // Build the tool allowlist (string names — 0.68.0 API).
  // IMPORTANT: the allowlist passed to createAgentSession filters MCP-provided
  // tools too. If we omit `ctx_execute` etc. they will not be callable even
  // though context-mode is installed — that was the bug behind implementers
  // burning context with `bash cat large-file` instead of `ctx_execute`.
  let toolNames: string[];
  if (options.tools === 'none') {
    toolNames = [];
  } else if (options.tools === 'readonly') {
    toolNames = ['read', 'grep', 'find', 'ls'];
  } else if (options.tools === 'review') {
    // Reviewer: read + search + bash for running tests, but no write/edit
    toolNames = ['read', 'bash', 'grep', 'find', 'ls'];
  } else {
    // Coding: full editing tools + search tools
    toolNames = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
  }

  // Conditionally add MCP-provided tools when their extensions are present.
  // Without these in the allowlist, the SDK silently filters them out — the
  // implementer sees only built-in tools no matter what the prompt says.
  if (toolNames.length > 0) {
    if (hasContextMode) {
      toolNames.push(
        'ctx_execute',
        'ctx_execute_file',
        'ctx_search',
        'ctx_index',
        'ctx_fetch_and_index',
        'ctx_batch_execute',
        'ctx_stats',
      );
    }
    if (hasLens) {
      toolNames.push('lsp_navigation', 'lsp_diagnostics', 'ast_grep_search');
      if (options.tools !== 'review' && options.tools !== 'readonly') {
        toolNames.push('ast_grep_replace');
      }
    }
    if (hasWebSearch) {
      toolNames.push('searxng_web_search', 'web_url_read');
    }
  }

  logger.info(`[SUBAGENT FACTORY] Tools loaded: ${options.tools || 'coding'}`);
  logger.info(`[SUBAGENT FACTORY] Allowlist: ${toolNames.join(', ') || '(none)'}`);
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
          terminate: true,
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

  // Context pruner budget. The pruner only sees the conversation history, but
  // the actual request the provider receives is:
  //
  //   system prompt + tool schemas + history + reserved output
  //
  // so the budget for history must subtract everything else from the window,
  // or the implementer overflows even while the pruner believes it is under
  // budget. We reserve the system prompt (estimated from its length), a flat
  // allowance for the tool JSON schemas, and the model's max output, then apply
  // an 0.85 headroom factor for residual token-estimate error.
  //
  // Set `contextBudgetTokens` explicitly on a profile to override this, or 0 to
  // opt out of pruning entirely.
  const sysPromptTokens = Math.ceil(populatedPrompt.length / CHARS_PER_TOKEN);
  const TOOL_SCHEMA_RESERVE = 4_000;
  const reserve = profile.maxOutputTokens + sysPromptTokens + TOOL_SCHEMA_RESERVE;
  const budgetTokens = profile.contextBudgetTokens
    ?? Math.max(8_000, Math.floor((profile.contextWindow - reserve) * 0.85));
  if (budgetTokens > 0) {
    extensionFactories.push(createContextPruner(options.taskType, budgetTokens));
    logger.info(`[SUBAGENT FACTORY] Registered context-pruner extension (budget=${budgetTokens} tok, window=${profile.contextWindow}, reserve=${reserve} [out=${profile.maxOutputTokens}, sys≈${sysPromptTokens}, schemas=${TOOL_SCHEMA_RESERVE}])`);
  } else {
    logger.info(`[SUBAGENT FACTORY] Context pruner disabled (contextBudgetTokens=0)`);
  }

  extensionFactories.push(createProviderTelemetry(options.taskType));

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: PI_AGENT_DIR,
    additionalExtensionPaths: extensionPaths,
    extensionFactories,
    systemPrompt: populatedPrompt,
    appendSystemPrompt: [],
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
    // Pass undefined instead of an empty array when no tools are requested.
    // vLLM rejects `tools: []` with HTTP 400 ("tools must not be an empty
    // array"), causing the request to fail silently with zero stream events —
    // the arbiter session was hitting this exact case.
    tools: toolNames.length > 0 ? toolNames : undefined,
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
    let allModels = session.modelRegistry.getAll();
    let targetModel = allModels.find((m) => m.id === targetModelId);

    // Cloud model not in the registry — this happens when the model was configured in the TDD
    // workflow but Pi's own models.json only has a different model for this provider (or none).
    // Persist it to Pi's models.json so all future sessions find it without needing a fallback.
    if (!targetModel && profile.provider !== 'local') {
      const baseUrl = options.modelRouter.getBaseURL(profile);
      const added = ensureModelInPiProvider(profile.modelId!, baseUrl);
      if (added) {
        logger.info(`[SUBAGENT FACTORY] Cloud model '${targetModelId}' added to Pi's models.json — refreshing registry`);
        session.modelRegistry.refresh();
        allModels = session.modelRegistry.getAll();
        targetModel = allModels.find((m) => m.id === targetModelId);
      }

      // Final fallback: if no matching provider in Pi's models.json, register for this session only
      if (!targetModel) {
        let apiKey: string | undefined;
        try { apiKey = options.modelRouter.getApiKey(profile); } catch { /* rely on Pi's stored auth */ }
        const providerConfig: ProviderConfig = {
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          models: [{
            id: profile.modelId!,
            name: profile.name,
            api: 'openai-completions',
            reasoning: profile.enableThinking ?? false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: profile.contextWindow,
            maxTokens: profile.maxOutputTokens,
          }],
        };
        session.modelRegistry.registerProvider(profile.provider, providerConfig);
        allModels = session.modelRegistry.getAll();
        targetModel = allModels.find((m) => m.id === targetModelId);
        if (targetModel) {
          logger.info(`[SUBAGENT FACTORY] Cloud model '${targetModelId}' registered for this session (no matching Pi provider found)`);
        }
      }
    }

    if (targetModel) {
      // Set the model directly on agent state to avoid the side-effect in session.setModel()
      // which persists to ~/.pi/agent/settings.json — undesirable for ephemeral subagents.
      (session as any).agent.state.model = targetModel;
      logger.info(`[SUBAGENT FACTORY] Model set to: ${targetModel.provider}/${targetModel.id}`);
    } else {
      const availableIds = allModels.map((m) => `${m.provider}/${m.id}`).slice(0, 10).join(', ');
      logger.warn(`[SUBAGENT FACTORY] Target model '${targetModelId}' not found in registry after extension binding. Available (first 10): ${availableIds}`);
      const fallbackId = session.model ? `${session.model.provider}/${session.model.id}` : 'undefined/undefined';
      logger.warn(`[SUBAGENT FACTORY] Using Pi's fallback model: ${fallbackId}`);
      options.notify?.(
        `⚠️ **${options.taskType}**: configured model \`${targetModelId}\` was not found in the model registry — ` +
        `fell back to \`${fallbackId}\`. ` +
        (session.model
          ? 'Responses may come from the wrong model.'
          : 'No usable model is set, so requests will produce no output. Check that the endpoint is up and the model id matches what it serves.'),
        'warning',
      );
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

// ─── Context pruning ───────────────────────────────────────────────────────
//
// Long implementer attempts accumulate huge tool_result payloads (bash/test
// output, large file reads). The Pi SDK keeps the entire history in-context
// for the model on every turn, so a 60-minute implementer run can easily
// blow past 200K tokens even when the model's window is much smaller.
//
// This pruner hooks Pi's `context` event and stubs out tool_result + tool_use
// payloads from older messages once the estimated token count crosses the
// configured budget. Recent messages are kept verbatim so the model still
// has the latest reviewer feedback and tool outputs to act on. The actual
// transcript on disk is unaffected — this only trims what the model sees
// for the next forward pass.

const TOOL_RESULT_STUB = '[tool result elided by context pruner — re-run the tool if you need it]';

// Tokens-per-character heuristic. English prose is ~4 chars/token, but the
// implementer's history is dominated by source code, JSON, and test logs,
// which tokenize closer to 3.3 chars/token. Using 4 systematically UNDERcounts
// that content, so the pruner believed it was under budget while the real
// request overflowed the window. 3.3 is the conservative middle.
export const CHARS_PER_TOKEN = 3.3;

export interface PruneStats {
  totalBefore: number;
  totalAfter: number;
  stubbedBlocks: number;
  /** Oversized tool_results that were head+tail truncated (incl. protected ones). */
  truncatedBlocks: number;
}

function estimateBlockTokens(block: any): number {
  if (!block || typeof block !== 'object') return 0;
  if (block.type === 'text' && typeof block.text === 'string') {
    return Math.ceil(block.text.length / CHARS_PER_TOKEN);
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return Math.ceil(block.thinking.length / CHARS_PER_TOKEN);
  }
  if (block.type === 'tool_use') {
    const inputStr = block.input ? JSON.stringify(block.input) : '';
    return Math.ceil((inputStr.length + (typeof block.name === 'string' ? block.name.length : 0)) / CHARS_PER_TOKEN);
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') return Math.ceil(block.content.length / CHARS_PER_TOKEN);
    if (Array.isArray(block.content)) {
      return block.content.reduce((sum: number, c: any) => {
        if (typeof c === 'string') return sum + Math.ceil(c.length / CHARS_PER_TOKEN);
        if (c?.type === 'text' && typeof c.text === 'string') return sum + Math.ceil(c.text.length / CHARS_PER_TOKEN);
        return sum + Math.ceil(JSON.stringify(c).length / CHARS_PER_TOKEN);
      }, 0);
    }
  }
  return Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
}

function estimateMessageTokens(msg: any): number {
  if (!msg) return 0;
  if (typeof msg.content === 'string') return Math.ceil(msg.content.length / CHARS_PER_TOKEN);
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum: number, b: any) => sum + estimateBlockTokens(b), 0);
  }
  return 0;
}

/**
 * Head+tail truncate a string to roughly `maxTokens`, keeping the start and end
 * (where the signal usually is) and dropping the middle. Returns the original
 * string unchanged if it already fits.
 */
function truncateText(s: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  if (s.length <= maxChars) return s;
  const keep = Math.floor(maxChars / 2);
  const omittedTokens = Math.ceil((s.length - keep * 2) / CHARS_PER_TOKEN);
  const marker = `\n…[${omittedTokens} tokens elided by context pruner — re-run the tool for full output]…\n`;
  return s.slice(0, keep) + marker + s.slice(s.length - keep);
}

/**
 * Cap a single tool_result block to `maxTokens` via head+tail truncation,
 * mutating the (already-cloned) block in place. Returns true if it truncated.
 * Handles both string content and the array-of-text-blocks shape; the text
 * budget is distributed proportionally across text blocks.
 */
function truncateToolResultBlock(block: any, maxTokens: number): boolean {
  if (!block || block.type !== 'tool_result') return false;
  if (estimateBlockTokens(block) <= maxTokens) return false;

  if (typeof block.content === 'string') {
    block.content = truncateText(block.content, maxTokens);
    return true;
  }
  if (Array.isArray(block.content)) {
    const totalTextTokens = block.content.reduce(
      (sum: number, c: any) =>
        c?.type === 'text' && typeof c.text === 'string'
          ? sum + Math.ceil(c.text.length / CHARS_PER_TOKEN)
          : sum,
      0,
    );
    if (totalTextTokens <= maxTokens) return false;
    let truncated = false;
    // Rebuild the array with fresh objects so we never mutate the caller's
    // (shallow-cloned) inner text blocks.
    block.content = block.content.map((c: any) => {
      if (c?.type !== 'text' || typeof c.text !== 'string') return c;
      const blockTokens = Math.ceil(c.text.length / CHARS_PER_TOKEN);
      const share = Math.max(1, Math.floor(maxTokens * (blockTokens / totalTextTokens)));
      const newText = truncateText(c.text, share);
      if (newText === c.text) return c;
      truncated = true;
      return { ...c, text: newText };
    });
    return truncated;
  }
  return false;
}

/**
 * Bring the conversation history under `budgetTokens`:
 *
 *  - Pass 0 caps any single oversized tool_result — INCLUDING ones inside the
 *    protected recent window — to `maxSingleResultTokens` via head+tail
 *    truncation. This is the guard against a fresh giant test/build dump or
 *    file read overflowing the window on its own, which full-message stubbing
 *    can't catch because the recent window is otherwise preserved verbatim.
 *  - Pass 1 walks oldest→newest stubbing whole tool_result payloads.
 *  - Pass 2 stubs tool_use input if still over.
 *
 * The last `keepRecentMessages` messages keep their structure (latest user
 * turn, latest tool roundtrip) so the model still has fresh ground truth; only
 * their oversized tool_results are capped.
 *
 * Returns a new array; the input is not mutated.
 */
export function pruneContextMessages(
  messages: any[],
  budgetTokens: number,
  keepRecentMessages = 4,
  maxSingleResultTokens = Math.max(4_000, Math.floor(budgetTokens / 4)),
): { messages: any[]; stats: PruneStats } {
  let totalBefore = 0;
  for (const m of messages) totalBefore += estimateMessageTokens(m);

  const protectStart = Math.max(0, messages.length - keepRecentMessages);

  // Is any tool_result (anywhere) oversized enough to need single-result
  // truncation? This can fire even when the total is under budget.
  let hasOversized = false;
  for (let i = 0; i < messages.length && !hasOversized; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_result' && estimateBlockTokens(block) > maxSingleResultTokens) {
        hasOversized = true;
        break;
      }
    }
  }

  if ((totalBefore <= budgetTokens && !hasOversized) || messages.length <= keepRecentMessages) {
    return { messages, stats: { totalBefore, totalAfter: totalBefore, stubbedBlocks: 0, truncatedBlocks: 0 } };
  }

  // Quick scan: if nothing in the prunable range is a tool_use/tool_result and
  // there is no oversized result anywhere, pruning can't help — return the
  // original array unchanged for identity.
  let hasPrunable = false;
  for (let i = 0; i < protectStart && !hasPrunable; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_result' || block?.type === 'tool_use') {
        hasPrunable = true;
        break;
      }
    }
  }
  if (!hasPrunable && !hasOversized) {
    return { messages, stats: { totalBefore, totalAfter: totalBefore, stubbedBlocks: 0, truncatedBlocks: 0 } };
  }

  let stubbedBlocks = 0;
  let truncatedBlocks = 0;
  let current = totalBefore;

  // Clone shallowly so the caller's array is untouched.
  const result = messages.map(m => {
    if (!m || !Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map((b: any) => ({ ...b })) };
  });

  // Pass 0: cap any single oversized tool_result (protected window included).
  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (!Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_result' && block.content !== TOOL_RESULT_STUB) {
        const before = estimateBlockTokens(block);
        if (truncateToolResultBlock(block, maxSingleResultTokens)) {
          current -= (before - estimateBlockTokens(block));
          truncatedBlocks++;
        }
      }
    }
  }

  // Pass 1: stub tool_result content (biggest payloads — bash/read output).
  for (let i = 0; i < protectStart && current > budgetTokens; i++) {
    const msg = result[i];
    if (!Array.isArray(msg?.content)) continue;
    for (let j = 0; j < msg.content.length && current > budgetTokens; j++) {
      const block = msg.content[j];
      if (block?.type === 'tool_result' && block.content !== TOOL_RESULT_STUB) {
        const before = estimateBlockTokens(block);
        block.content = TOOL_RESULT_STUB;
        const after = estimateBlockTokens(block);
        current -= (before - after);
        stubbedBlocks++;
      }
    }
  }

  // Pass 2: stub tool_use input if still over (rarely needed — tool args are
  // usually small, but a giant `write` payload can blow past on its own).
  for (let i = 0; i < protectStart && current > budgetTokens; i++) {
    const msg = result[i];
    if (!Array.isArray(msg?.content)) continue;
    for (let j = 0; j < msg.content.length && current > budgetTokens; j++) {
      const block = msg.content[j];
      if (block?.type === 'tool_use' && block.input && (block.input as any).__pruned !== true) {
        const before = estimateBlockTokens(block);
        block.input = { __pruned: true };
        const after = estimateBlockTokens(block);
        current -= (before - after);
        stubbedBlocks++;
      }
    }
  }

  return { messages: result, stats: { totalBefore, totalAfter: current, stubbedBlocks, truncatedBlocks } };
}

/** Wraps pruneContextMessages as a Pi SDK extension factory. */
function createContextPruner(taskType: TaskType, budgetTokens: number): ExtensionFactory {
  return (pi) => {
    const log = getLogger();
    let lastLogTokens = 0;
    pi.on('context', (event) => {
      const { messages: pruned, stats } = pruneContextMessages(event.messages, budgetTokens);
      if (stats.stubbedBlocks > 0 || stats.truncatedBlocks > 0) {
        log.warn(
          `[CONTEXT PRUNER ${taskType}] stubbed ${stats.stubbedBlocks}, truncated ${stats.truncatedBlocks} block(s); ` +
          `~${stats.totalBefore} → ${stats.totalAfter} tok (budget ${budgetTokens})`,
        );
        lastLogTokens = stats.totalAfter;
      } else if (stats.totalBefore - lastLogTokens > 5000) {
        log.info(`[CONTEXT PRUNER ${taskType}] history ~${stats.totalBefore} tok (budget ${budgetTokens})`);
        lastLogTokens = stats.totalBefore;
      }
      return { messages: pruned };
    });
  };
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

/**
 * Per-session provider-call telemetry. Pairs `before_provider_request` with
 * `after_provider_response` to log status + latency, and warns on non-2xx so
 * rate limits and provider errors surface in the existing log without needing
 * a separate dashboard.
 */
function createProviderTelemetry(taskType: TaskType): ExtensionFactory {
  return (pi) => {
    const log = getLogger();
    let requestStart = 0;
    pi.on('before_provider_request', () => {
      requestStart = Date.now();
    });
    pi.on('after_provider_response', (event) => {
      const elapsedMs = requestStart > 0 ? Date.now() - requestStart : -1;
      const rateLimit = event.headers['x-ratelimit-remaining'] ?? event.headers['anthropic-ratelimit-requests-remaining'];
      const tag = `[SUBAGENT TELEMETRY ${taskType}]`;
      const latencyStr = elapsedMs >= 0 ? `${elapsedMs}ms` : 'n/a';
      const rateStr = rateLimit ? ` rate-remaining=${rateLimit}` : '';
      if (event.status >= 400) {
        log.warn(`${tag} status=${event.status} latency=${latencyStr}${rateStr}`);
      } else {
        log.info(`${tag} status=${event.status} latency=${latencyStr}${rateStr}`);
      }
    });
  };
}

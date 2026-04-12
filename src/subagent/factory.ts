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
import * as path from 'path';
import { type Model } from '@mariozechner/pi-ai';
import { ModelRouter, type TaskType, type ModelProfile } from '../llm/model-router.js';
import { getLogger } from '../utils/logger.js';
import { getAskUserForClarificationParams, type AskUserForClarificationArgs } from './tools.js';

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

  // Map ModelProfile to Pi's Model format
  // Note: Pi's Model type matches our Profile's provider/id structure
  const piModel: Model<any> = {
    id: profile.modelId || profile.ggufFilename,
    provider: profile.provider,
    name: profile.name,
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
    // Add other fields if needed for Pi compatibility
  } as any;

  logger.info(`Spawning sub-agent [${options.taskType}] with model: ${piModel.id}`);
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

  // Create the resource loader for the custom prompt.
  // We explicitly load the project's pi-lens extension so it's available as tools.
  const extensionPaths = [path.join(options.cwd, 'node_modules/pi-lens')];

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

  // Create the ephemeral session
  logger.info(`[SUBAGENT FACTORY] Creating agent session with model: ${piModel.id}`);
  const { session } = await createAgentSession({
    cwd: options.cwd,
    sessionManager: SessionManager.inMemory(), // Ephemeral session
    resourceLoader: loader,
    // model: intentionally omitted — use the Pi SDK's default model selection
    // unless a per-agent override is configured in models.config.json
    tools: baseTools,
    customTools,
  });
  
  // Give async extensions (like pi-mcp-adapter) time to establish their RPC bounds
  // before the LLM fires off its first context exploration tool.
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Log available tools so operators can verify extension tools (ctx_execute, lsp_navigation, etc.) loaded
  try {
    const availableTools = ((session as any).tools as any[] | undefined)?.map((t: any) => t.name || t.label).filter(Boolean) || [];
    logger.info(`[SUBAGENT FACTORY] Available tools: ${availableTools.join(', ') || '(none detected)'}`);
  } catch {
    logger.info(`[SUBAGENT FACTORY] Could not enumerate session tools`);
  }

  logger.info(`[SUBAGENT FACTORY] Agent session created successfully`);

  // Apply thinking level if specified in profile
  if (profile.enableThinking) {
     session.setThinkingLevel('medium'); // Default to medium for reasoning models
     logger.info(`[SUBAGENT FACTORY] Thinking level set to: medium`);
  } else {
     session.setThinkingLevel('off');
     logger.info(`[SUBAGENT FACTORY] Thinking level set to: off`);
  }

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

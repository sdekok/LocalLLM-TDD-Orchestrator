import { 
  createAgentSession, 
  SessionManager, 
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  type AgentSession,
  type ToolDefinition,
  type ExtensionContext,
  type AgentToolResult,
  type AgentToolUpdateCallback
} from '@mariozechner/pi-coding-agent';
import * as path from 'path';
import { type Model } from '@mariozechner/pi-ai';
import { ModelRouter, type TaskType, type ModelProfile } from '../llm/model-router.js';
import { getTuner } from '../llm/tuners/registry.js';
import { getLogger } from '../utils/logger.js';
import { getAskUserForClarificationParams, type AskUserForClarificationArgs } from './tools.js';

export interface SubAgentOptions {
  taskType: TaskType;
  systemPrompt: string;
  cwd: string;
  modelRouter: ModelRouter;
  feedback?: string;
  tools?: 'coding' | 'readonly' | 'none';
  // Optional: UI context for interactive tools (e.g., ask_user_for_clarification)
  uiContext?: {
    input: (prompt: string) => Promise<string | null>;
    notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  };
  customTools?: ToolDefinition[];
}

/**
 * Factory for spawning ephemeral Pi sub-agent sessions.
 * Integrates with the existing ModelRouter and ModelTuner system.
 */
export async function createSubAgentSession(options: SubAgentOptions): Promise<AgentSession> {
  const logger = getLogger();
  const profile = options.modelRouter.selectModel(options.taskType);
  logger.info(`[SUBAGENT FACTORY] Selected model for ${options.taskType}: ${profile.modelId || profile.ggufFilename}`);
  logger.info(`[SUBAGENT FACTORY] Model provider: ${profile.provider}, Thinking enabled: ${profile.enableThinking}`);
  
  const tuner = getTuner(profile.modelFamily);

  // Apply model-specific tweaks (thinking, prompt mutations, sampling floor)
  const samplingParams = options.modelRouter.getSamplingParams(options.taskType);
  const { systemPrompt: tunedPrompt, sampling } = tuner.applyTweaks(
    profile,
    options.systemPrompt,
    samplingParams
  );
  
  logger.info(`[SUBAGENT FACTORY] Tuning applied.`);

  // Inject feedback Context if provided
  const feedbackContext = options.feedback
    ? `\n\nPREVIOUS ATTEMPT FAILED. Feedback for this attempt:\n${options.feedback}\n\nFix these issues.`
    : '';
  
  const finalPrompt = tunedPrompt.replace('{feedbackContext}', feedbackContext);

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
  logger.info(`[SUBAGENT FACTORY] System prompt length: ${finalPrompt.length} characters`);
  logger.info(`[SUBAGENT FACTORY] System prompt preview: ${finalPrompt.substring(0, 200)}...`);

  // Build the tools list
  const baseTools = options.tools === 'none'
    ? []
    : options.tools === 'readonly' 
      ? createReadOnlyTools(options.cwd)
      : createCodingTools(options.cwd);
  
  logger.info(`[SUBAGENT FACTORY] Tools loaded: ${options.tools === 'readonly' ? 'readonly' : 'coding'}`);
  logger.info(`[SUBAGENT FACTORY] Final prompt (first 500 chars):\n${finalPrompt.substring(0, 500)}...`);

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
  
  const loader = new DefaultResourceLoader({
    additionalExtensionPaths: extensionPaths,
    systemPromptOverride: () => finalPrompt,
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
    // model: piModel,
    tools: baseTools,
    customTools,
  });
  
  // Give async extensions (like pi-mcp-adapter) time to establish their RPC bounds
  // before the LLM fires off its first context exploration tool.
  await new Promise(resolve => setTimeout(resolve, 2000));

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

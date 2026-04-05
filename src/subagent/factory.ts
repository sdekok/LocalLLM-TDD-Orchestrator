import { 
  createAgentSession, 
  SessionManager, 
  createCodingTools,
    createReadOnlyTools,
    type AgentSession
  } from '@mariozechner/pi-coding-agent';
  import { type Model } from '@mariozechner/pi-ai';
import { ModelRouter, type TaskType, type ModelProfile } from '../llm/model-router.js';
import { getTuner } from '../llm/tuners/registry.js';
import { getLogger } from '../utils/logger.js';

export interface SubAgentOptions {
  taskType: TaskType;
  systemPrompt: string;
  cwd: string;
  modelRouter: ModelRouter;
  feedback?: string;
  tools?: 'coding' | 'readonly';
}

/**
 * Factory for spawning ephemeral Pi sub-agent sessions.
 * Integrates with the existing ModelRouter and ModelTuner system.
 */
export async function createSubAgentSession(options: SubAgentOptions): Promise<AgentSession> {
  const logger = getLogger();
  const profile = options.modelRouter.selectModel(options.taskType);
  const tuner = getTuner(profile.modelFamily);

  // Apply model-specific tweaks (thinking, prompt mutations, sampling floor)
  const samplingParams = options.modelRouter.getSamplingParams(options.taskType);
  const { systemPrompt } = tuner.applyTweaks(
    profile,
    options.systemPrompt,
    samplingParams
  );

  // Inject feedback Context if provided
  const feedbackContext = options.feedback
    ? `\n\nPREVIOUS ATTEMPT FAILED. Feedback for this attempt:\n${options.feedback}\n\nFix these issues.`
    : '';
  
  const finalPrompt = systemPrompt.replace('{feedbackContext}', feedbackContext);

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

  // Create the ephemeral session
  const { session } = await createAgentSession({
    cwd: options.cwd,
    sessionManager: SessionManager.inMemory(), // Ephemeral session
    model: piModel,
    // Use factories to ensure tools resolve correctly to the sandbox cwd
    tools: options.tools === 'readonly' 
      ? createReadOnlyTools(options.cwd) 
      : createCodingTools(options.cwd),
    // Inject the tuned system prompt via a custom ResourceLoader or by directly setting it
    // The easiest way is to set it on the agent state immediately after creation
  });

  // Set the tuned system prompt
  session.agent.state.systemPrompt = finalPrompt;
  
  // Apply thinking level if specified in profile
  if (profile.enableThinking) {
     session.setThinkingLevel('medium'); // Default to medium for reasoning models
  } else {
     session.setThinkingLevel('off');
  }

  return session;
}

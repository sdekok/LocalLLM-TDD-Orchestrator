import { createSubAgentSession } from '../subagent/factory.js';
import { PROJECT_PLANNER_PROMPT } from '../subagent/prompts.js';
import { ModelRouter } from '../llm/model-router.js';
import { getLogger } from '../utils/logger.js';

export interface ProjectPlanResult {
  summary: string;
}

/**
 * Spawns a project planning sub-agent session.
 * This sub-agent is responsible for:
 * 1. Exploring the codebase.
 * 2. Decomposing a request into epics and work items.
 * 3. Writing markdown files to WorkItems/.
 * 4. Appending architectural decisions to agents.md.
 */
export async function planProject(
  request: string,
  modelRouter: ModelRouter,
  cwd: string
): Promise<ProjectPlanResult> {
  const logger = getLogger();
  logger.info(`Starting project-level planning for: ${request.substring(0, 100)}`);

  const session = await createSubAgentSession({
    taskType: 'project-plan',
    systemPrompt: PROJECT_PLANNER_PROMPT,
    cwd,
    modelRouter,
    tools: 'coding' // Needs write access to WorkItems/ and agents.md
  });

  try {
    // The session is interactive so we send the initial prompt
    await session.prompt(request);
    
    // Once the session completes (the agent stops calling tools), we assume it's done.
    // In a future version, we might extract structured results, 
    // but for now the agent writes files directly via tools.
    
    return {
      summary: `Project planning complete. Check the WorkItems/ directory for epics and work items.`
    };
  } finally {
    session.dispose();
  }
}

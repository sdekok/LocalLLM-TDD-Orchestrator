import { LLMClient } from '../llm/client.js';
import { SearchClient, shouldSearch } from '../search/searxng.js';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../utils/logger.js';
import { ModelRouter } from '../llm/model-router.js';
import { PLANNER_PROMPT } from '../subagent/prompts.js';

const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string', description: 'Step-by-step reasoning for the proposed task list' },
    refinedRequest: { type: 'string' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          affectedFiles: { type: 'array', items: { type: 'string' }, description: 'List of files likely to be modified by this task' },
        },
        required: ['description'],
      },
    },
  },
  required: ['reasoning', 'refinedRequest', 'subtasks'],
};

export interface PlanResult {
  reasoning: string;
  refinedRequest: string;
  subtasks: { id: string; description: string; affectedFiles?: string[] }[];
}

export async function planAndBreakdown(
  request: string,
  modelRouter: ModelRouter,
  searchClient?: SearchClient
): Promise<PlanResult> {
  const logger = getLogger();
  const llm = new LLMClient(modelRouter);
  logger.info('Planning and breaking down request...');

  // Optionally research before planning
  let researchContext = '';
  if (searchClient && shouldSearch(request, 1)) {
    try {
      const research = await searchClient.searchAndSummarize(
        `${request} best practices implementation guide`,
        2
      );
      researchContext = `\n\nRelevant research from the web:\n${research}`;
      logger.info(`Fetched research context: ${research.length} chars`);
    } catch (err) {
      logger.warn(`Search failed during planning: ${err}`);
    }
  }

  const result = await llm.askStructured<{
    reasoning: string;
    refinedRequest: string;
    subtasks: { description: string; affectedFiles?: string[] }[];
  }>(PLANNER_PROMPT, `${request}${researchContext}`, PLANNER_SCHEMA, 'plan', 0.3);

  const subtasks = result.subtasks.map((t) => ({
    id: uuidv4(),
    description: t.description,
    affectedFiles: t.affectedFiles,
  }));

  logger.info(`Created ${subtasks.length} subtasks`);
  return { reasoning: result.reasoning, refinedRequest: result.refinedRequest, subtasks };
}

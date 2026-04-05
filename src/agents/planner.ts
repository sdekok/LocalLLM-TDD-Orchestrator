import { LLMClient } from '../llm/client.js';
import { SearchClient, shouldSearch } from '../search/searxng.js';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../utils/logger.js';
import { ModelRouter } from '../llm/model-router.js';
import { PLANNER_PROMPT } from '../subagent/prompts.js';

const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    refinedRequest: { type: 'string' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
        },
        required: ['description'],
      },
    },
  },
  required: ['refinedRequest', 'subtasks'],
};

export interface PlanResult {
  refinedRequest: string;
  subtasks: { id: string; description: string }[];
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
    refinedRequest: string;
    subtasks: { description: string }[];
  }>(PLANNER_PROMPT, `${request}${researchContext}`, PLANNER_SCHEMA, 'plan', 0.3);

  const subtasks = result.subtasks.map((t) => ({
    id: uuidv4(),
    description: t.description,
  }));

  logger.info(`Created ${subtasks.length} subtasks`);
  return { refinedRequest: result.refinedRequest, subtasks };
}

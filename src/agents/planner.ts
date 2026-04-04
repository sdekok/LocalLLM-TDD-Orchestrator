import { LLMClient } from '../llm/client.js';
import { SearchClient, shouldSearch } from '../search/searxng.js';
import { v4 as uuidv4 } from 'uuid';
import { getLogger } from '../utils/logger.js';

const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    refinedRequest: { type: 'string', description: 'A clear, refined version of the original request.' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A specific, testable vertical slice of functionality.' },
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
  llm: LLMClient,
  searchClient?: SearchClient
): Promise<PlanResult> {
  const logger = getLogger();
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

  const systemPrompt = `You are an expert software architect and planner.
Your job is to take a raw user request, ensure it is completely understood, and break it down into fine, cross-cutting slices of functionality.
Each slice must be a detailed subtask that can be executed in a Test-Driven Development (TDD) way.
Focus on vertical slices that result in testable integrations.
Order subtasks by dependency — foundational work first, integration last.`;

  const result = await llm.askStructured<{
    refinedRequest: string;
    subtasks: { description: string }[];
  }>(systemPrompt, `${request}${researchContext}`, PLANNER_SCHEMA, 'plan', 0.3);

  const subtasks = result.subtasks.map((t) => ({
    id: uuidv4(),
    description: t.description,
  }));

  logger.info(`Created ${subtasks.length} subtasks`);
  return { refinedRequest: result.refinedRequest, subtasks };
}

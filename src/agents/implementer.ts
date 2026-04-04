import { LLMClient } from '../llm/client.js';
import { type WorkspaceSnapshot, formatSnapshotForPrompt } from '../context/gatherer.js';
import { SearchClient, shouldSearch } from '../search/searxng.js';
import { getLogger } from '../utils/logger.js';

const IMPLEMENTER_SCHEMA = {
  type: 'object',
  properties: {
    tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filepath: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['filepath', 'content'],
      },
    },
    code: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filepath: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['filepath', 'content'],
      },
    },
    summary: { type: 'string', description: 'Brief explanation of the implementation.' },
  },
  required: ['tests', 'code', 'summary'],
};

export interface FileOutput {
  filepath: string;
  content: string;
}

export interface ImplementationResult {
  tests: FileOutput[];
  code: FileOutput[];
  summary: string;
}

export async function implementSubtask(
  description: string,
  snapshot: WorkspaceSnapshot,
  llm: LLMClient,
  options?: {
    feedbackContext?: string;
    attempt?: number;
    searchClient?: SearchClient;
  }
): Promise<ImplementationResult> {
  const logger = getLogger();
  const attempt = options?.attempt || 1;
  logger.info(`Implementing subtask (attempt ${attempt}): ${description.substring(0, 80)}...`);

  // Optionally search for API docs
  let searchContext = '';
  if (options?.searchClient && shouldSearch(description, attempt, options.feedbackContext)) {
    try {
      const docs = await options.searchClient.searchAndSummarize(
        `${description} API documentation example ${snapshot.language}`,
        2
      );
      searchContext = `\n\nReference documentation (from web search):\n${docs}`;
      logger.info(`Fetched API docs: ${docs.length} chars`);
    } catch (err) {
      logger.warn(`Search failed during implementation: ${err}`);
    }
  }

  const projectContext = formatSnapshotForPrompt(snapshot);

  const systemPrompt = `You are an expert Test-Driven Development (TDD) implementer.

${projectContext}
${searchContext}

Your task:
1. Write test files FIRST covering the feature and edge cases.
2. Write the minimal source code to make those tests pass.
3. Use the project's existing conventions (test framework: ${snapshot.testFramework}, language: ${snapshot.language}).
4. Use correct import paths relative to the project structure.
5. All file paths must be relative to the project root (e.g., "src/auth/middleware.ts").

${options?.feedbackContext ? `IMPORTANT — Fix these issues from the previous attempt:\n${options.feedbackContext}` : ''}`;

  return llm.askStructured<ImplementationResult>(
    systemPrompt,
    description,
    IMPLEMENTER_SCHEMA,
    'implement',
    0.2
  );
}

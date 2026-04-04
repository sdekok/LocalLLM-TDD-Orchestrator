import { LLMClient } from '../llm/client.js';
import { type WorkspaceSnapshot, formatSnapshotForPrompt } from '../context/gatherer.js';
import { SearchClient, shouldSearch } from '../search/searxng.js';
import { getLogger } from '../utils/logger.js';

const DESIGNER_SCHEMA = {
  type: 'object',
  properties: {
    components: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Component name in PascalCase.' },
          filepath: { type: 'string', description: 'Suggested file path relative to project root.' },
          purpose: { type: 'string', description: 'What this component does and when it should be used.' },
          props: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                required: { type: 'boolean' },
                description: { type: 'string' },
              },
              required: ['name', 'type', 'required'],
            },
          },
          designTokens: {
            type: 'object',
            description: 'Suggested design tokens (colors, spacing, typography).',
          },
          variants: {
            type: 'array',
            items: { type: 'string' },
            description: 'Visual variants (e.g., primary, secondary, ghost).',
          },
        },
        required: ['name', 'filepath', 'purpose', 'props'],
      },
    },
    layoutSuggestion: { type: 'string', description: 'High-level layout and visual hierarchy description.' },
    designSystemNotes: { type: 'string', description: 'Notes on how this fits into the existing design system.' },
  },
  required: ['components', 'layoutSuggestion'],
};

export interface ComponentSpec {
  name: string;
  filepath: string;
  purpose: string;
  props: { name: string; type: string; required: boolean; description?: string }[];
  designTokens?: Record<string, unknown>;
  variants?: string[];
}

export interface DesignResult {
  components: ComponentSpec[];
  layoutSuggestion: string;
  designSystemNotes?: string;
}

export async function designPrototype(
  description: string,
  snapshot: WorkspaceSnapshot,
  llm: LLMClient,
  options?: {
    searchClient?: SearchClient;
  }
): Promise<DesignResult> {
  const logger = getLogger();
  logger.info(`Designing UI prototype: ${description.substring(0, 80)}...`);

  let searchContext = '';
  if (options?.searchClient && shouldSearch(description, 1)) {
    try {
      const docs = await options.searchClient.searchAndSummarize(
        `${description} UI component design patterns best practices`,
        2
      );
      searchContext = `\n\nReference UI patterns (from web search):\n${docs}`;
    } catch (err) {
      logger.warn(`Search failed during design: ${err}`);
    }
  }

  const projectContext = formatSnapshotForPrompt(snapshot);

  const systemPrompt = `You are an expert UI/UX designer and frontend architect.

${projectContext}
${searchContext}

Your task is to design the component architecture for a feature. You must:
1. Break the feature into reusable, composable components.
2. Define the props interface for each component.
3. Suggest design tokens (colors, spacing, typography) that fit the existing design system.
4. Identify component variants (e.g., primary/secondary/ghost for buttons).
5. Suggest file paths that follow the project's existing conventions.
6. Prioritize reuse — if a similar component already exists in the project, extend it rather than creating a new one.

Output ONLY component specifications. Do NOT write implementation code — the implementer agent will handle that.`;

  return llm.askStructured<DesignResult>(
    systemPrompt,
    description,
    DESIGNER_SCHEMA,
    'design',
    0.3
  );
}

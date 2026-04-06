import { LLMClient } from '../llm/client.js';
import { type WorkspaceSnapshot, formatSnapshotForPrompt } from '../context/gatherer.js';
import { getLogger } from '../utils/logger.js';

export interface ComponentSpec {
  name: string;
  props?: Record<string, any>;
  description?: string;
}

const DESIGN_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    duplicateComponents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          proposed: { type: 'string', description: 'Name of the proposed component.' },
          existingMatch: { type: 'string', description: 'Name/path of the existing similar component.' },
          similarity: { type: 'string', description: 'What makes them similar.' },
          recommendation: { type: 'string', description: 'Extend existing, merge, or keep both.' },
        },
        required: ['proposed', 'existingMatch', 'similarity', 'recommendation'],
      },
    },
    tokenConsistency: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['issue', 'suggestion'],
      },
    },
    namingIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string' },
          issue: { type: 'string' },
          suggestedName: { type: 'string' },
        },
        required: ['component', 'issue', 'suggestedName'],
      },
    },
    approved: { type: 'boolean', description: 'True if no blocking duplication or consistency issues.' },
    summary: { type: 'string' },
  },
  required: ['duplicateComponents', 'tokenConsistency', 'namingIssues', 'approved', 'summary'],
};

export interface DuplicateCheck {
  proposed: string;
  existingMatch: string;
  similarity: string;
  recommendation: string;
}

export interface TokenIssue {
  issue: string;
  suggestion: string;
}

export interface NamingIssue {
  component: string;
  issue: string;
  suggestedName: string;
}

export interface DesignReviewResult {
  duplicateComponents: DuplicateCheck[];
  tokenConsistency: TokenIssue[];
  namingIssues: NamingIssue[];
  approved: boolean;
  summary: string;
}

export async function reviewDesign(
  proposedComponents: ComponentSpec[],
  snapshot: WorkspaceSnapshot,
  llm: LLMClient
): Promise<DesignReviewResult> {
  const logger = getLogger();
  logger.info(`Reviewing ${proposedComponents.length} proposed components for design consistency...`);

  const projectContext = formatSnapshotForPrompt(snapshot);

  const systemPrompt = `You are a design system architect performing a strict consistency review.

${projectContext}

Your job is to ensure new components fit the existing design system. Check for:

1. **Component Duplication**: Are any proposed components too similar to existing ones?
   - Compare props interfaces, visual purpose, and naming
   - If >70% overlap, recommend extending the existing component instead

2. **Design Token Consistency**: Do the proposed design tokens match existing patterns?
   - Check color naming conventions (e.g., primary-500 vs brand-primary)
   - Check spacing scale consistency (4px grid? 8px grid?)
   - Check typography scale alignment

3. **Naming Conventions**: Do component and prop names follow existing patterns?
   - PascalCase for components?
   - camelCase for props?
   - Consistent prefix patterns (e.g., is/has for booleans)?

Set approved=true only if there are NO duplicate components found.`;

  const userPrompt = `Proposed components:\n${JSON.stringify(proposedComponents, null, 2)}`;

  return llm.askStructured<DesignReviewResult>(
    systemPrompt,
    userPrompt,
    DESIGN_REVIEW_SCHEMA,
    'design_review',
    0.1
  );
}

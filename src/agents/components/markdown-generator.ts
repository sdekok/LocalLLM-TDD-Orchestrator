import { type ProjectPlan } from '../project-plan-schema.js';

/**
 * Generates a markdown representation of the plan for user review.
 * This provides a human-readable summary before committing to files.
 */
export function generatePlanMarkdown(plan: ProjectPlan): string {
  const lines: string[] = [];

  lines.push(`# Project Plan: ${plan.summary}`);
  lines.push('');

  lines.push('## Architectural Decisions');
  if (plan.architecturalDecisions.length === 0) {
    lines.push('*None.*');
  } else {
    plan.architecturalDecisions.forEach(dec => lines.push(`- ${dec}`));
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  plan.epics.forEach((epic, idx) => {
    lines.push(`## Epic ${idx + 1}: ${epic.title}`);
    lines.push('');
    lines.push(epic.description);
    lines.push('');

    epic.workItems.forEach(wi => {
      lines.push(...formatWorkItemMarkdown(wi));
    });
  });

  return lines.join('\n');
}

/**
 * Formats a single work item as the standard ticket markdown.
 */
export function formatWorkItemMarkdown(wi: {
  id: string;
  title: string;
  description: string;
  filesToCreate?: string[];
  filesToModify?: string[];
  dependencies?: { read?: string[]; blocksOn?: string[] };
  implementationSteps?: string[];
  technicalConstraints?: string[];
  acceptance: string[];
  tests: string[];
  edgeCases?: string[];
  relatedDocs?: string[];
  devNotes?: string;
  security?: string;
}): string[] {
  const lines: string[] = [];

  lines.push(`### ${wi.id}: ${wi.title}`);
  lines.push('');

  // Summary
  lines.push('#### Summary');
  lines.push(wi.description);
  lines.push('');

  // Files To Create/Modify
  const hasFiles = (wi.filesToCreate?.length ?? 0) + (wi.filesToModify?.length ?? 0) > 0;
  if (hasFiles) {
    lines.push('#### Files To Create/Modify');
    (wi.filesToCreate ?? []).forEach(f => lines.push(`- \`${f}\` - new`));
    (wi.filesToModify ?? []).forEach(f => lines.push(`- \`${f}\` - modify`));
    lines.push('');
  }

  // Dependencies
  const readDeps = wi.dependencies?.read ?? [];
  const blocksOn = wi.dependencies?.blocksOn ?? [];
  if (readDeps.length > 0 || blocksOn.length > 0) {
    lines.push('#### Dependencies');
    readDeps.forEach(d => lines.push(`- Read: \`${d}\``));
    blocksOn.forEach(b => lines.push(`- Blocks on: ${b}`));
    lines.push('');
  }

  // Implementation Steps
  if (wi.implementationSteps?.length) {
    lines.push('#### Implementation Steps');
    wi.implementationSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push('');
  }

  // Technical Constraints
  if (wi.technicalConstraints?.length) {
    lines.push('#### Technical Constraints');
    wi.technicalConstraints.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  // Acceptance Criteria
  lines.push('#### Acceptance Criteria');
  wi.acceptance.forEach(a => lines.push(`- [ ] ${a}`));
  lines.push('');

  // Recommended Tests
  if (wi.tests?.length) {
    lines.push('#### Recommended Tests');
    wi.tests.forEach(t => lines.push(`- ${t}`));
    lines.push('');
  }

  // Edge Cases
  if (wi.edgeCases?.length) {
    lines.push('#### Edge Cases to Handle');
    wi.edgeCases.forEach(e => lines.push(`- ${e}`));
    lines.push('');
  }

  // Security
  if (wi.security) {
    lines.push('#### Security');
    lines.push(wi.security);
    lines.push('');
  }

  // Dev Notes
  if (wi.devNotes) {
    lines.push('#### Dev Notes');
    lines.push(wi.devNotes);
    lines.push('');
  }

  // Related Docs
  if (wi.relatedDocs?.length) {
    lines.push('#### Related Docs');
    wi.relatedDocs.forEach(d => lines.push(`- \`${d}\``));
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  return lines;
}

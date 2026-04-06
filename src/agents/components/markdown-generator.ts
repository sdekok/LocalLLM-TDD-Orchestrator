import { type ProjectPlan } from '../project-plan-schema.js';

/**
 * Generates a markdown representation of the plan for user review.
 * This provides a human-readable summary before committing to files.
 */
export function generatePlanMarkdown(plan: ProjectPlan): string {
  const lines: string[] = [];
  
  // Title
  lines.push(`# Project Plan: ${plan.summary}`);
  lines.push('');
  
  // Architectural Decisions
  lines.push('## Architectural Decisions');
  if (plan.architecturalDecisions.length === 0) {
    lines.push('*No architectural decisions recorded.*');
  } else {
    plan.architecturalDecisions.forEach(dec => {
      lines.push(`- ${dec}`);
    });
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Epics
  plan.epics.forEach((epic, idx) => {
    lines.push(`## Epic ${idx + 1}: ${epic.title}`);
    lines.push('');
    lines.push(epic.description);
    lines.push('');
    lines.push('### Work Items');
    lines.push('');
    
    epic.workItems.forEach(wi => {
      lines.push(`#### ${wi.id}: ${wi.title}`);
      lines.push('');
      lines.push(wi.description);
      lines.push('');
      lines.push(`**Acceptance Criteria**:`);
      lines.push('');
      wi.acceptance.forEach(a => {
        lines.push(`- ${a}`);
      });
      lines.push('');
      lines.push('---');
      lines.push('');
    });
  });

  return lines.join('\n');
}

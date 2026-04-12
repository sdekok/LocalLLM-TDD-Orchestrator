import { z } from 'zod';

/**
 * Zod schema for the Project Plan.
 * This ensures the agent returns a structured, valid plan.
 */
export const ProjectPlanSchema = z.object({
  reasoning: z.string().optional().describe("Step-by-step reasoning for the proposed architecture and task breakdown."),
  summary: z.string().describe("A high-level summary of the project or request."),
  epics: z.array(
    z.object({
      title: z.string().describe("The title of the epic."),
      slug: z.string().describe("A URL-friendly slug for the epic (e.g., 'auth-system')."),
      description: z.string().describe("A detailed description of the epic's scope."),
      securityStrategy: z.string().optional().describe("High-level security considerations for this epic."),
      testStrategy: z.string().optional().describe("Overall testing approach for this epic."),
      workItems: z.array(
        z.object({
          id: z.string().describe("A unique identifier (e.g., 'WI-1')."),
          title: z.string().describe("The title of the work item."),
          description: z.string().describe("A detailed description of the task."),
          acceptance: z.array(z.string()).describe("Detailed bullet points of specific, verifiable criteria for the TDD cycle."),
          security: z.string().optional().describe("Specific security considerations for this work item."),
          tests: z.array(z.string()).describe("A list of specific test cases to be implemented (e.g. 'Should throw Error when input is negative')."),
          devNotes: z.string().optional().describe("Implementation notes, technical gotchas, or library recommendations."),
          filesAffected: z.array(z.string()).optional().describe("List of files likely to be touched by this work item."),
        })
      ).describe("The sequence of small, atomic TDD tasks within this epic."),
    })
  ).describe("The major phases or modules of the project."),
  architecturalDecisions: z.array(z.string()).describe("A list of key architectural decisions made during planning."),
});

export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

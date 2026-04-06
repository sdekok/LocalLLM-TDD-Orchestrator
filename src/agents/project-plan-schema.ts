import { z } from 'zod';

/**
 * Zod schema for the Project Plan.
 * This ensures the agent returns a structured, valid plan.
 */
export const ProjectPlanSchema = z.object({
  summary: z.string().describe("A high-level summary of the project or request."),
  epics: z.array(
    z.object({
      title: z.string().describe("The title of the epic."),
      slug: z.string().describe("A URL-friendly slug for the epic (e.g., 'auth-system')."),
      description: z.string().describe("A detailed description of the epic's scope."),
      workItems: z.array(
        z.object({
          id: z.string().describe("A unique identifier (e.g., 'WI-1')."),
          title: z.string().describe("The title of the work item."),
          description: z.string().describe("A detailed description of the task."),
          acceptance: z.string().describe("Concrete acceptance criteria for the TDD cycle."),
        })
      ).describe("The sequence of small, atomic TDD tasks within this epic."),
    })
  ).describe("The major phases or modules of the project."),
  architecturalDecisions: z.array(z.string()).describe("A list of key architectural decisions made during planning."),
});

export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

import { z } from 'zod';

// ─── Work Item ────────────────────────────────────────────────────────────────

export const WorkItemSchema = z.object({
  id: z.string().describe("A unique identifier (e.g., 'WI-1')."),
  title: z.string().describe("The title of the work item."),
  description: z.string().describe("One sentence: what this does and why."),
  filesToCreate: z.array(z.string()).optional().describe("Files to create, each as 'path/to/file - reason'."),
  filesToModify: z.array(z.string()).optional().describe("Files to modify, each as 'path/to/file - reason'."),
  dependencies: z.object({
    read: z.array(z.string()).optional().describe("Docs or files to read before starting."),
    blocksOn: z.array(z.string()).optional().describe("Work item IDs this blocks on (e.g. 'WI-2')."),
  }).optional().describe("Read dependencies and blocking work items."),
  implementationSteps: z.array(z.string()).optional().describe("Ordered implementation steps."),
  technicalConstraints: z.array(z.string()).optional().describe("Libraries, conventions, or patterns to follow."),
  acceptance: z.array(z.string()).describe("Specific, verifiable acceptance criteria."),
  security: z.string().optional().describe("Specific security considerations for this work item."),
  tests: z.array(z.string()).describe("Test cases, prefixed with type: 'Unit: ...', 'Integration: ...', 'Visual: ...'."),
  edgeCases: z.array(z.string()).optional().describe("Edge cases to handle (null/empty, loading, error, responsive)."),
  relatedDocs: z.array(z.string()).optional().describe("Paths to related documentation files."),
  devNotes: z.string().optional().describe("Implementation notes, technical gotchas, or library recommendations."),
  filesAffected: z.array(z.string()).optional().describe("Legacy: list of files likely to be touched (use filesToCreate/filesToModify instead)."),
});

// ─── Epic ─────────────────────────────────────────────────────────────────────

export const EpicSchema = z.object({
  title: z.string().describe("The title of the epic."),
  slug: z.string().describe("A URL-friendly slug for the epic (e.g., 'auth-system')."),
  description: z.string().describe("A detailed description of the epic's scope."),
  securityStrategy: z.string().optional().describe("High-level security considerations for this epic."),
  testStrategy: z.string().optional().describe("Overall testing approach for this epic."),
  workItems: z.array(WorkItemSchema).describe("The sequence of small, atomic TDD tasks within this epic."),
});

// ─── Phase 1: Epic overview (no work items) ───────────────────────────────────

export const EpicOverviewSchema = z.object({
  summary: z.string().describe("A high-level summary of the project or request."),
  architecturalDecisions: z.array(z.string()).describe("Key architectural decisions made during planning."),
  epics: z.array(z.object({
    title: z.string().describe("Epic title."),
    slug: z.string().describe("URL-friendly slug."),
    description: z.string().describe("What this epic covers."),
  })).describe("Ordered list of epics — no work items yet."),
});

// ─── Full plan (Phase 1 + Phase 2 combined) ───────────────────────────────────

export const ProjectPlanSchema = z.object({
  reasoning: z.string().optional().describe("Step-by-step reasoning for the proposed architecture and task breakdown."),
  summary: z.string().describe("A high-level summary of the project or request."),
  epics: z.array(EpicSchema).describe("The major phases or modules of the project."),
  architecturalDecisions: z.array(z.string()).describe("A list of key architectural decisions made during planning."),
});

export type WorkItem = z.infer<typeof WorkItemSchema>;
export type Epic = z.infer<typeof EpicSchema>;
export type EpicOverview = z.infer<typeof EpicOverviewSchema>;
export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;

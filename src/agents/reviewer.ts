import { LLMClient } from '../llm/client.js';
import type { FileOutput } from './implementer.js';
import type { QualityReport } from '../orchestrator/quality-gates.js';
import { getLogger } from '../utils/logger.js';

const REVIEWER_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: {
        test_coverage: { type: 'number', description: 'Score 1-5 for test quality and edge case coverage.' },
        integration: { type: 'number', description: 'Score 1-5 for how well it integrates with existing code.' },
        error_handling: { type: 'number', description: 'Score 1-5 for error handling and unhappy paths.' },
        security: { type: 'number', description: 'Score 1-5 for security and input validation.' },
      },
      required: ['test_coverage', 'integration', 'error_handling', 'security'],
    },
    approved: { type: 'boolean', description: 'True only if total score >= 14/20 AND all scores >= 3.' },
    feedback: { type: 'string', description: 'Specific, actionable feedback.' },
  },
  required: ['scores', 'approved', 'feedback'],
};

export interface ReviewScores {
  test_coverage: number;
  integration: number;
  error_handling: number;
  security: number;
}

export interface ReviewResult {
  scores: ReviewScores;
  approved: boolean;
  feedback: string;
}

export async function reviewImplementation(
  originalRequirement: string,
  taskDescription: string,
  testsProduced: FileOutput[],
  codeProduced: FileOutput[],
  qualityGateReport: QualityReport,
  llm: LLMClient
): Promise<ReviewResult> {
  const logger = getLogger();
  logger.info('Starting adversarial review...');

  const systemPrompt = `You are a skeptical senior engineer performing a hostile code review.
Your DEFAULT position is REJECTION. You are looking for reasons to reject, not reasons to approve.

Evaluate against these criteria and score each 1-5:

1. **Test Coverage**: Do the tests actually test meaningful behavior, or are they trivial?
   - Are edge cases covered? (null inputs, empty arrays, error conditions)
   - Do the tests verify behavior, not implementation details?
   - Would the tests catch a regression if someone refactored the code?

2. **Integration Correctness**: Does this code integrate with the existing codebase?
   - Are imports correct and consistent with existing patterns?
   - Does it follow existing naming conventions?
   - Would it actually work when called from the rest of the application?

3. **Error Handling**: What happens when things go wrong?
   - Are errors caught and handled appropriately?
   - Are error messages useful for debugging?
   - Is there any unhappy-path testing?

4. **Security & Safety**: Any obvious security issues?
   - Input validation?
   - Injection vulnerabilities?
   - Hardcoded secrets?

Score each criterion 1-5. Set approved=true ONLY if ALL criteria score >= 3 AND total >= 14/20.
If you approve despite concerns, justify WHY. Be specific in your feedback.`;

  const gatesSummary = qualityGateReport.gates
    .map((g) => `${g.gate}: ${g.passed ? 'PASS' : 'FAIL'}${g.blocking ? ' (blocking)' : ''}`)
    .join('\n');

  const userPrompt = `
Original Requirement: ${originalRequirement}

Specific Task: ${taskDescription}

Quality Gate Results:
${gatesSummary}

Tests Written:
${JSON.stringify(testsProduced.map((t) => ({ filepath: t.filepath, content: t.content.substring(0, 3000) })), null, 2)}

Code Written:
${JSON.stringify(codeProduced.map((c) => ({ filepath: c.filepath, content: c.content.substring(0, 3000) })), null, 2)}
`;

  const result = await llm.askStructured<ReviewResult>(
    systemPrompt,
    userPrompt,
    REVIEWER_SCHEMA,
    'review',
    0.1
  );

  const totalScore =
    result.scores.test_coverage +
    result.scores.integration +
    result.scores.error_handling +
    result.scores.security;

  logger.info(
    `Review scores: coverage=${result.scores.test_coverage} integration=${result.scores.integration} ` +
    `errors=${result.scores.error_handling} security=${result.scores.security} total=${totalScore}/20 approved=${result.approved}`
  );

  return result;
}

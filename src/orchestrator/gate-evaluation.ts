import { diffGateFailures, type GateResult } from './quality-gates.js';
import { boundFeedbackForPrompt } from './feedback.js';

export interface GateEvaluation {
  /** Gates with genuinely NEW failures introduced by this attempt. */
  regressionGates: GateResult[];
  /** One feedback report per regression gate, ready for the implementer prompt. */
  regressionReports: string[];
  /** Labels like "lint(12 pre-existing)" for gates whose failures all predate the task. */
  preexistingGates: string[];
}

/**
 * Compare each failing blocking gate against the workflow baseline. If every
 * error in the current output was already present at baseline, the gate is
 * pre-existing and ignored. Otherwise the report contains only the NEW errors —
 * not the full failure dump — so the implementer isn't distracted by legacy
 * issues it wasn't asked to fix.
 */
export function evaluateGateFailures(
  gates: GateResult[],
  baselineGateOutputs: Map<string, string>,
): GateEvaluation {
  const regressionReports: string[] = [];
  const regressionGates: GateResult[] = [];
  const preexistingGates: string[] = [];

  for (const g of gates) {
    if (!g.blocking || g.passed) continue;
    const baseline = baselineGateOutputs.get(g.gate);
    if (baseline === undefined) {
      // No baseline for this gate — it was green before, now red. Full regression.
      // Bound the raw gate output — a failing test/build can emit hundreds of KB
      // that would otherwise blow the implementer/arbiter context window. Full
      // output is in the gate report on disk.
      regressionGates.push(g);
      regressionReports.push(`[${g.gate.toUpperCase()} BLOCKING]\n${boundFeedbackForPrompt(g.output, 4000)}`);
      continue;
    }
    const { newErrors, baselineCount, currentCount } = diffGateFailures(g.gate, baseline, g.output);
    if (newErrors.length === 0) {
      preexistingGates.push(`${g.gate}(${currentCount} pre-existing)`);
      continue;
    }
    regressionGates.push(g);
    // Cap the new-error list — a single broken import can cascade into
    // thousands of failing-test signatures; the head is what's actionable.
    const MAX_LISTED_ERRORS = 40;
    const listed = newErrors.slice(0, MAX_LISTED_ERRORS).map(e => `  • ${e}`).join('\n');
    const moreErrors = newErrors.length > MAX_LISTED_ERRORS
      ? `\n  … and ${newErrors.length - MAX_LISTED_ERRORS} more new error(s) — see the gate report in .tdd-workflow/logs`
      : '';
    regressionReports.push(
      `[${g.gate.toUpperCase()} BLOCKING] ${newErrors.length} new error(s) introduced ` +
      `(baseline had ${baselineCount}, now ${currentCount}):\n` +
      listed + moreErrors
    );
  }

  return { regressionGates, regressionReports, preexistingGates };
}

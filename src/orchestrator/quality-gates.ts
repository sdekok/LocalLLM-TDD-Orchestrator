import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import { getTestRunner, type TestMetrics, type CoverageMetrics, type TestResult } from './test-runner.js';

const execAsync = promisify(exec);

export interface GateResult {
  gate: string;
  passed: boolean;
  output: string;
  blocking: boolean;
}

// Test and Coverage metrics are now imported from test-runner.ts
export type { TestMetrics, CoverageMetrics };

export interface QualityReport {
  gates: GateResult[];
  allBlockingPassed: boolean;
  testMetrics?: TestMetrics;
  coverageMetrics?: CoverageMetrics;
}

export async function runQualityGates(projectDir: string): Promise<QualityReport> {
  const logger = getLogger();
  const gates: GateResult[] = [];
  let testMetrics: TestMetrics | undefined;
  let coverageMetrics: CoverageMetrics | undefined;

  // Gate 1: TypeScript compilation (BLOCKING)
  const tsconfigPath = path.join(projectDir, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    gates.push(await runGate('typescript', 'npx tsc --noEmit', projectDir, true, 60_000));
  }

  // Gate 2: Tests pass (BLOCKING)
  const runner = getTestRunner(projectDir);
  if (runner) {
    const pkgJsonPath = path.join(projectDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    
    // Check if we should run with coverage
    const hasCoverageScript = pkg.scripts?.['test:coverage'] || pkg.scripts?.coverage;
    const isVitest = runner.name === 'vitest' && (pkg.devDependencies?.['@vitest/coverage-v8'] || pkg.devDependencies?.['@vitest/coverage-istanbul']);
    
    let result: TestResult;
    if (hasCoverageScript || isVitest) {
      result = await runner.runCoverage(projectDir, 120_000);
      coverageMetrics = result.coverage;
    } else {
      result = await runner.runTests(projectDir, 120_000);
    }

    gates.push({
      gate: 'tests',
      passed: result.passed,
      output: result.output,
      blocking: true,
    });

    testMetrics = result.metrics;

    // Gate 2b: Coverage Threshold (BLOCKING)
    if (coverageMetrics) {
      const thresholds = pkg.tddConfig?.coverageThresholds || { lines: 80, functions: 80, branches: 70 };
      const coveragePass = checkCoverageThresholds(coverageMetrics, thresholds);
      
      gates.push({
        gate: 'coverage',
        passed: coveragePass.passed,
        output: coveragePass.message,
        blocking: true,
      });
    }
  } else {
    logger.warn('No test runner detected — skipping test gate');
  }

  // Gate 3: Lint (NON-BLOCKING)
  const eslintConfig = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'].some(
    (f) => fs.existsSync(path.join(projectDir, f))
  );
  if (eslintConfig) {
    gates.push(await runGate('lint', 'npx eslint . --ext .ts,.js --max-warnings 0', projectDir, false, 30_000));
  }

  // Gate 4: File safety (BLOCKING)
  gates.push(await checkFileSafety(projectDir));

  const allBlockingPassed = gates.filter((g) => g.blocking).every((g) => g.passed);
  logger.info(`Quality gates: ${gates.filter((g) => g.passed).length}/${gates.length} passed (blocking: ${allBlockingPassed})`);

  if (testMetrics) {
    logger.info(`Tests: ${testMetrics.passed}/${testMetrics.total} passed, ${testMetrics.failed} failed, ${testMetrics.skipped} skipped`);
  }
  if (coverageMetrics) {
    logger.info(`Coverage: lines=${coverageMetrics.lines}% branches=${coverageMetrics.branches}% functions=${coverageMetrics.functions}%`);
  }

  return { gates, allBlockingPassed, testMetrics, coverageMetrics };
}

async function runGate(
  name: string,
  command: string,
  cwd: string,
  blocking: boolean,
  timeoutMs: number
): Promise<GateResult> {
  const logger = getLogger();
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs });
    logger.info(`Gate '${name}' PASSED`);
    return { gate: name, passed: true, output: (stdout + '\n' + stderr).trim(), blocking };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim();
    logger.info(`Gate '${name}' FAILED: ${output.substring(0, 200)}`);
    return { gate: name, passed: false, output, blocking };
  }
}

/**
 * Check metrics against thresholds
 */
function checkCoverageThresholds(metrics: CoverageMetrics, thresholds: Partial<CoverageMetrics>): { passed: boolean; message: string } {
  const failures: string[] = [];
  if (thresholds.lines && metrics.lines < thresholds.lines) failures.push(`Lines: ${metrics.lines}% < ${thresholds.lines}%`);
  if (thresholds.functions && metrics.functions < thresholds.functions) failures.push(`Functions: ${metrics.functions}% < ${thresholds.functions}%`);
  if (thresholds.branches && metrics.branches < thresholds.branches) failures.push(`Branches: ${metrics.branches}% < ${thresholds.branches}%`);
  if (thresholds.statements && metrics.statements < thresholds.statements) failures.push(`Statements: ${metrics.statements}% < ${thresholds.statements}%`);

  if (failures.length > 0) {
    return { passed: false, message: `Coverage thresholds NOT met:\n${failures.join('\n')}` };
  }
  return { passed: true, message: 'All coverage thresholds met.' };
}

// ─── Test Command Detection ──────────────────────────────────────

// Removed manual test detection — handled by test-runner.ts

// ─── File Safety ─────────────────────────────────────────────────

async function checkFileSafety(projectDir: string): Promise<GateResult> {
  try {
    const { stdout } = await execAsync('git diff --name-only HEAD 2>/dev/null || git ls-files --others --exclude-standard', {
      cwd: projectDir,
      timeout: 10_000,
    });

    const unexpectedFiles = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => {
        return (
          !f.startsWith('src/') &&
          !f.startsWith('tests/') &&
          !f.startsWith('test/') &&
          !f.startsWith('__tests__/') &&
          !f.startsWith('lib/') &&
          !f.startsWith('coverage/') &&
          !f.match(/^(package\.json|tsconfig\.json|\.eslintrc|vitest\.config|jest\.config)/)
        );
      });

    return {
      gate: 'file-safety',
      passed: unexpectedFiles.length === 0,
      output: unexpectedFiles.length > 0
        ? `Unexpected files outside standard directories:\n${unexpectedFiles.join('\n')}`
        : 'All files in expected locations',
      blocking: true,
    };
  } catch {
    return { gate: 'file-safety', passed: true, output: 'Git not available — skipped', blocking: true };
  }
}

// ─── Formatting ──────────────────────────────────────────────────

export function formatGateFailures(report: QualityReport): string {
  const failed = report.gates.filter((g) => !g.passed);
  if (failed.length === 0) return 'All gates passed.';

  return failed
    .map((g) => `[${g.gate.toUpperCase()} ${g.blocking ? 'BLOCKING' : 'WARNING'}]\n${g.output}`)
    .join('\n\n');
}

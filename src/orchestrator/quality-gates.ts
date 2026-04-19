import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import { execFileAsync, DEFAULT_MAX_BUFFER } from '../utils/exec.js';
import { getTestRunner, type TestMetrics, type CoverageMetrics, type TestResult } from './test-runner.js';

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

  // Gate 0: Lens Analysis (BLOCKING - New structural and deep type checks)
  const lensReport = await runLensGate(projectDir);
  gates.push(lensReport);
  if (!lensReport.passed) {
    logger.warn('Lens analysis found blocking structural or type issues.');
  }

  // Gate 1: TypeScript compilation (BLOCKING - legacy fallback)
  // If Lens passed, we still run full TSC for final safety until Lens is fully proven
  const tsconfigPath = path.join(projectDir, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    gates.push(await runGate('typescript', ['npx', 'tsc', '--noEmit'], projectDir, true, 60_000));
  }

  // Gate 2: Tests pass (BLOCKING)
  const runner = getTestRunner(projectDir);
  if (runner) {
    const pkgJsonPath = path.join(projectDir, 'package.json');
    let pkg: any = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch (err) {
      logger.warn(`Failed to parse ${pkgJsonPath}: ${(err as Error).message}`);
    }

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
    gates.push(await runGate('lint', ['npx', 'eslint', '.', '--ext', '.ts,.js', '--max-warnings', '0'], projectDir, false, 30_000));
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

/**
 * Run a quality gate command.
 * Accepts a command as [program, ...args] to avoid shell injection —
 * execFile does not spawn a shell so arguments are passed directly.
 */
async function runGate(
  name: string,
  command: [string, ...string[]],
  cwd: string,
  blocking: boolean,
  timeoutMs: number
): Promise<GateResult> {
  const logger = getLogger();
  const [program, ...args] = command;
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
    });
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

/**
 * Controls what happens when the Lens gate itself crashes (e.g. lens-bridge
 * is not installed on this machine).
 *
 * - 'fail-closed'  (default): a crash is treated as a gate failure.
 *                  Use this in CI and production environments.
 * - 'fail-open':   a crash is treated as a pass (old behaviour).
 *                  Set LENS_FAIL_POLICY=fail-open on developer machines where
 *                  Lens is not installed and you do not want to block work.
 *
 * The choice is read from the LENS_FAIL_POLICY environment variable so it is
 * visible in logs and auditable, rather than being a silent hidden default.
 */
export type LensFailPolicy = 'fail-closed' | 'fail-open';

export function getLensFailPolicy(): LensFailPolicy {
  const raw = process.env['LENS_FAIL_POLICY'];
  if (raw === 'fail-open') return 'fail-open';
  return 'fail-closed'; // secure default
}

/**
 * Runs pi-lens analysis as a quality gate.
 * Leverages LSP diagnostics and structural bug patterns.
 */
async function runLensGate(projectDir: string): Promise<GateResult> {
  const logger = getLogger();
  try {
    // Use JS bridge to avoid tsc strictly checking pi-lens source inside node_modules
    // @ts-ignore
    const { getLensClients } = await import('./lens-bridge.js');
    const { TypeScriptClient, AstGrepClient } = await getLensClients();

    const tsClient = new TypeScriptClient();
    const agClient = new AstGrepClient();

    let output = '';
    const issues: string[] = [];

    // 1. LSP Diagnostics (Deep Type Checks)
    // Scan all src and test files
    const files = await getSourceFiles(projectDir);
    for (const file of files) {
      if (tsClient.isTypeScriptFile(file)) {
        const diags = tsClient.getDiagnostics(file);
        const errors = diags.filter((d: any) => d.severity === 1);
        if (errors.length > 0) {
          issues.push(`[LSP] ${path.relative(projectDir, file)}: ${errors.length} error(s)`);
          errors.slice(0, 3).forEach((e: any) => {
            issues.push(`  L${e.range.start.line + 1}: ${e.message}`);
          });
        }
      }
    }

    // 2. Structural Analysis (Bug Patterns)
    if (await agClient.ensureAvailable()) {
      for (const file of files) {
        const structuralDiags = agClient.scanFile(file);
        const blockingStyles = structuralDiags.filter((d: any) => d.severity === 'error');
        if (blockingStyles.length > 0) {
          const report = agClient.formatDiagnostics(blockingStyles);
          issues.push(`[Structural] ${path.relative(projectDir, file)}:\n${report}`);
        }
      }
    }

    const passed = issues.length === 0;
    output = passed ? 'Lens analysis passed. No structural or type blockers found.' : issues.join('\n');

    return {
      gate: 'lens',
      passed,
      output,
      blocking: true,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Lens gate crashed: ${errMsg}`);

    const policy = getLensFailPolicy();
    const passed = policy === 'fail-open';
    const policyLabel = policy === 'fail-open'
      ? 'fail-open policy: treating as passed'
      : 'fail-closed policy: treating as failed';

    return {
      gate: 'lens',
      passed,
      output: `Lens analysis failed to run (${policyLabel}): ${errMsg}`,
      blocking: true,
    };
  }
}

/**
 * Helper to get source files for analysis
 */
async function getSourceFiles(projectDir: string): Promise<string[]> {
  const walk = (dir: string): string[] => {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat && stat.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'lib', 'coverage'].includes(file)) continue;
        results = results.concat(walk(fullPath));
      } else {
        if (file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.tsx') || file.endsWith('.jsx')) {
          results.push(fullPath);
        }
      }
    }
    return results;
  };
  return walk(projectDir);
}

// ─── File Safety ─────────────────────────────────────────────────

/**
 * Built-in prefixes that are always allowed in file-safety checks.
 * Projects can extend this list via package.json#tddConfig.fileSafetyAllowlist.
 *
 * Each entry is matched as a path prefix (e.g. "docs/" matches "docs/foo/bar.md").
 * Entries without a trailing slash are matched exactly as a prefix, so "docs"
 * would also match "docs-extra/". Always use a trailing slash for directory entries.
 */
const BUILTIN_SAFE_PREFIXES = [
  'src/',
  'tests/',
  'test/',
  '__tests__/',
  'lib/',
  'libs/',
  'apps/',
  'packages/',
  'docs/',
  'coverage/',
  '.pi-lens/',
  '.tdd-workflow/',
];

const BUILTIN_SAFE_PATTERNS = [
  /^(package\.json|tsconfig\.json|\.eslintrc|vitest\.config|jest\.config)/,
];

function loadFileSafetyAllowlist(projectDir: string): string[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    const extra: unknown = pkg?.tddConfig?.fileSafetyAllowlist;
    if (Array.isArray(extra)) {
      return (extra as unknown[]).filter((e): e is string => typeof e === 'string');
    }
  } catch {
    // No package.json or no tddConfig — fine
  }
  return [];
}

async function checkFileSafety(projectDir: string): Promise<GateResult> {
  try {
    let stdout: string;

    try {
      // Try to get files changed since last commit
      const result = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], {
        cwd: projectDir,
        timeout: 10_000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });
      stdout = result.stdout;
    } catch {
      // No commits yet or not a git repo — list untracked files instead
      const result = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: projectDir,
        timeout: 10_000,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });
      stdout = result.stdout;
    }

    const extraPrefixes = loadFileSafetyAllowlist(projectDir);
    const allPrefixes = [...BUILTIN_SAFE_PREFIXES, ...extraPrefixes];

    const unexpectedFiles = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((f) => {
        if (BUILTIN_SAFE_PATTERNS.some(re => re.test(f))) return false;
        return !allPrefixes.some(prefix => f.startsWith(prefix));
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

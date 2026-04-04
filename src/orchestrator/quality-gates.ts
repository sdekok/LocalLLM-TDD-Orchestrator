import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import { detectTestFramework } from '../context/gatherer.js';

const execAsync = promisify(exec);

export interface GateResult {
  gate: string;
  passed: boolean;
  output: string;
  blocking: boolean;
}

export interface TestMetrics {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface CoverageMetrics {
  lines: number;       // percentage
  branches: number;    // percentage
  functions: number;   // percentage
  statements: number;  // percentage
}

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
  const testCmd = await detectTestCommand(projectDir);
  if (testCmd) {
    // Determine if we should run with coverage
    const coverageCmd = await detectCoverageCommand(projectDir, testCmd);
    const cmdToRun = coverageCmd || testCmd;

    const testResult = await runGate('tests', cmdToRun, projectDir, true, 120_000);
    gates.push(testResult);

    // Parse test metrics from output
    testMetrics = parseTestMetrics(testResult.output);

    // Parse coverage if we ran with coverage
    if (coverageCmd) {
      coverageMetrics = await parseCoverageMetrics(projectDir, testResult.output);
    }
  } else {
    logger.warn('No test command detected — skipping test gate');
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

// ─── Test Metrics Parsing ────────────────────────────────────────

/**
 * Parse test count from runner output. Supports vitest, jest, mocha, and node:test.
 */
export function parseTestMetrics(output: string): TestMetrics | undefined {
  // Vitest: look for the "Tests" line (NOT "Test Files")
  // "      Tests  85 passed | 2 failed (87)"
  // "      Tests  94 passed (94)"
  const testsLineMatch = output.match(/^\s*Tests\s+(.+\(\d+\))\s*$/m);
  if (testsLineMatch) {
    const line = testsLineMatch[1]!;
    const totalMatch = line.match(/\((\d+)\)/);
    const total = totalMatch ? parseInt(totalMatch[1]!, 10) : 0;
    const passedMatch = line.match(/(\d+)\s+passed/i);
    const failedMatch = line.match(/(\d+)\s+failed/i);
    const skippedMatch = line.match(/(\d+)\s+skipped/i);
    return {
      total,
      passed: passedMatch ? parseInt(passedMatch[1]!, 10) : 0,
      failed: failedMatch ? parseInt(failedMatch[1]!, 10) : 0,
      skipped: skippedMatch ? parseInt(skippedMatch[1]!, 10) : 0,
    };
  }

  // Jest: "Tests: 2 failed, 10 passed, 12 total"
  const jestMatch = output.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(\d+)\s+passed,\s*(\d+)\s+total/i);
  if (jestMatch) {
    return {
      failed: parseInt(jestMatch[1] || '0', 10),
      passed: parseInt(jestMatch[2]!, 10),
      total: parseInt(jestMatch[3]!, 10),
      skipped: 0,
    };
  }

  // Mocha: "10 passing" / "2 failing"
  const mochaPass = output.match(/(\d+)\s+passing/i);
  const mochaFail = output.match(/(\d+)\s+failing/i);
  const mochaPend = output.match(/(\d+)\s+pending/i);
  if (mochaPass) {
    const passed = parseInt(mochaPass[1]!, 10);
    const failed = mochaFail ? parseInt(mochaFail[1]!, 10) : 0;
    const skipped = mochaPend ? parseInt(mochaPend[1]!, 10) : 0;
    return { passed, failed, skipped, total: passed + failed + skipped };
  }

  // node:test: "# tests 5" / "# pass 4" / "# fail 1"
  const nodeTotal = output.match(/# tests (\d+)/);
  const nodePass = output.match(/# pass (\d+)/);
  const nodeFail = output.match(/# fail (\d+)/);
  if (nodeTotal) {
    return {
      total: parseInt(nodeTotal[1]!, 10),
      passed: nodePass ? parseInt(nodePass[1]!, 10) : 0,
      failed: nodeFail ? parseInt(nodeFail[1]!, 10) : 0,
      skipped: 0,
    };
  }

  return undefined;
}

// ─── Coverage Support ────────────────────────────────────────────

/**
 * Detect if a coverage command can be constructed for this test framework.
 */
export async function detectCoverageCommand(projectDir: string, testCmd: string): Promise<string | null> {
  const pkgJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Check for existing coverage script
    if (pkg.scripts?.['test:coverage']) return 'npm run test:coverage';
    if (pkg.scripts?.coverage) return 'npm run coverage';

    // Vitest has built-in coverage via --coverage
    if (allDeps.vitest && (allDeps['@vitest/coverage-v8'] || allDeps['@vitest/coverage-istanbul'])) {
      return 'npx vitest run --coverage --reporter=json';
    }

    // Jest has built-in coverage
    if (allDeps.jest) {
      return 'npx jest --passWithNoTests --coverage --coverageReporters=json-summary';
    }

    // c8 (Node.js coverage tool)
    if (allDeps.c8) {
      return `npx c8 --reporter=json-summary ${testCmd}`;
    }

    // nyc/istanbul
    if (allDeps.nyc || allDeps.istanbul) {
      return `npx nyc --reporter=json-summary ${testCmd}`;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parse coverage metrics from coverage output or JSON report files.
 */
export async function parseCoverageMetrics(projectDir: string, testOutput: string): Promise<CoverageMetrics | undefined> {
  // Try JSON summary file first (most tools write this)
  const coveragePaths = [
    path.join(projectDir, 'coverage', 'coverage-summary.json'),
    path.join(projectDir, 'coverage', 'coverage-final.json'),
  ];

  for (const coveragePath of coveragePaths) {
    if (fs.existsSync(coveragePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
        const total = data.total;
        if (total) {
          return {
            lines: total.lines?.pct ?? 0,
            branches: total.branches?.pct ?? 0,
            functions: total.functions?.pct ?? 0,
            statements: total.statements?.pct ?? 0,
          };
        }
      } catch {
        // Malformed coverage file
      }
    }
  }

  // Fallback: parse text output
  // Vitest/Jest text reporter: "All files  |   85.7 |   72.3 |    90  |   85.7"
  //                     or:    "Statements : 85.7%"
  const stmtMatch = testOutput.match(/Statements?\s*[:|]\s*([\d.]+)%?/i);
  const branchMatch = testOutput.match(/Branches?\s*[:|]\s*([\d.]+)%?/i);
  const funcMatch = testOutput.match(/Functions?\s*[:|]\s*([\d.]+)%?/i);
  const lineMatch = testOutput.match(/Lines?\s*[:|]\s*([\d.]+)%?/i);

  if (stmtMatch || lineMatch) {
    return {
      statements: stmtMatch ? parseFloat(stmtMatch[1]!) : 0,
      branches: branchMatch ? parseFloat(branchMatch[1]!) : 0,
      functions: funcMatch ? parseFloat(funcMatch[1]!) : 0,
      lines: lineMatch ? parseFloat(lineMatch[1]!) : 0,
    };
  }

  return undefined;
}

// ─── Test Command Detection ──────────────────────────────────────

export async function detectTestCommand(projectDir: string): Promise<string | null> {
  const pkgJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = detectTestFramework(allDeps);

    switch (framework) {
      case 'vitest': return 'npx vitest run';
      case 'jest': return 'npx jest --passWithNoTests';
      case 'mocha': return 'npx mocha';
      case 'ava': return 'npx ava';
      default:
        if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
          return 'npm test';
        }
        return null;
    }
  } catch {
    return null;
  }
}

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

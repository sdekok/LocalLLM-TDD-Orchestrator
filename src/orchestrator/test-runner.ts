import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';

const execAsync = promisify(exec);

export interface TestMetrics {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface CoverageMetrics {
  lines: number;
  branches: number;
  functions: number;
  statements: number;
}

export interface TestResult {
  passed: boolean;
  output: string;
  metrics?: TestMetrics;
  coverage?: CoverageMetrics;
}

export interface TestRunner {
  name: string;
  runTests(projectDir: string, timeoutMs: number): Promise<TestResult>;
  runCoverage(projectDir: string, timeoutMs: number): Promise<TestResult>;
}

/**
 * Detect which package manager is in use for a project directory.
 * Returns the executable name: 'pnpm', 'yarn', 'bun', or 'npm'.
 */
export function detectPackageManager(projectDir: string): string {
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectDir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/**
 * Base class for common test runner logic.
 */
export abstract class BaseTestRunner implements TestRunner {
  abstract name: string;
  abstract runTests(projectDir: string, timeoutMs: number): Promise<TestResult>;
  abstract runCoverage(projectDir: string, timeoutMs: number): Promise<TestResult>;

  protected async execWithTimeout(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; passed: boolean; timedOut?: boolean }> {
    const logger = getLogger();
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs });
      return { stdout, stderr, passed: true };
    } catch (err: any) {
      // When `exec` hits the timeout it SIGTERMs the child and returns partial
      // output. We flag it so upstream can annotate the gate output with a
      // truncation warning instead of silently treating "0 tests found" as a
      // genuine regression.
      const timedOut = err.killed === true || err.signal === 'SIGTERM';
      if (timedOut) {
        logger.warn(`[TestRunner] Command timed out after ${timeoutMs / 1000}s: ${command}`);
      }
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        passed: false,
        timedOut,
      };
    }
  }

  protected parseJSONCoverage(projectDir: string): CoverageMetrics | undefined {
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
          // Ignore malformed files
        }
      }
    }
    return undefined;
  }
}

/**
 * Vitest Implementation
 *
 * Prefers `<pm> run test` / `<pm> run test:coverage` from package.json scripts
 * so that project-level vitest configs (environment, globals, plugins) are picked
 * up correctly. Falls back to `npx vitest run` when no test script is defined.
 */
export class VitestRunner extends BaseTestRunner {
  name = 'vitest';

  async runTests(projectDir: string, timeoutMs: number): Promise<TestResult> {
    const command = this.resolveTestCommand(projectDir);
    const { stdout, stderr, passed, timedOut } = await this.execWithTimeout(command, projectDir, timeoutMs);
    const output = this.annotateIfTimedOut(stdout + '\n' + stderr, timedOut, timeoutMs);
    return {
      passed,
      output,
      metrics: this.parseTestMetrics(output)
    };
  }

  async runCoverage(projectDir: string, timeoutMs: number): Promise<TestResult> {
    // @vitest/coverage-v8 writes coverage-summary.json to the coverage/ directory
    // automatically — no extra reporter flag needed (json-summary is not a built-in
    // in vitest v4 and causes a startup crash if specified).
    const command = this.resolveCoverageCommand(projectDir);
    const { stdout, stderr, passed, timedOut } = await this.execWithTimeout(command, projectDir, timeoutMs);
    const output = this.annotateIfTimedOut(stdout + '\n' + stderr, timedOut, timeoutMs);
    return {
      passed,
      output,
      metrics: this.parseTestMetrics(output),
      coverage: this.parseJSONCoverage(projectDir) || this.parseTextCoverage(output)
    };
  }

  protected annotateIfTimedOut(output: string, timedOut: boolean | undefined, timeoutMs: number): string {
    if (!timedOut) return output;
    return `[TIMEOUT after ${timeoutMs / 1000}s — output below is partial; counts and summary may be missing]\n${output}`;
  }

  /**
   * Resolve the test command to run.
   * Uses `<pm> run test` if package.json defines a `test` script,
   * otherwise falls back to `npx vitest run`.
   */
  private resolveTestCommand(projectDir: string): string {
    const scripts = this.readScripts(projectDir);
    if (scripts?.test) {
      return `${detectPackageManager(projectDir)} run test`;
    }
    return 'npx vitest run';
  }

  /**
   * Resolve the coverage command to run.
   * Prefers `test:coverage` script, then `coverage` script,
   * then falls back to `npx vitest run --coverage`.
   */
  private resolveCoverageCommand(projectDir: string): string {
    const scripts = this.readScripts(projectDir);
    const pm = detectPackageManager(projectDir);
    if (scripts?.['test:coverage']) return `${pm} run test:coverage`;
    if (scripts?.coverage) return `${pm} run coverage`;
    return 'npx vitest run --coverage';
  }

  private readScripts(projectDir: string): Record<string, string> | undefined {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
      return pkg.scripts;
    } catch {
      return undefined;
    }
  }

  private parseTestMetrics(output: string): TestMetrics | undefined {
    const testsLineMatch = output.match(/^\s*Tests\s+(.+\(\d+\))\s*$/m);
    if (!testsLineMatch) return undefined;

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

  private parseTextCoverage(output: string): CoverageMetrics | undefined {
    const stmtMatch = output.match(/Statements?\s*[:|]\s*([\d.]+)%?/i);
    const branchMatch = output.match(/Branches?\s*[:|]\s*([\d.]+)%?/i);
    const funcMatch = output.match(/Functions?\s*[:|]\s*([\d.]+)%?/i);
    const lineMatch = output.match(/Lines?\s*[:|]\s*([\d.]+)%?/i);

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
}

/**
 * Resolve the test command the project uses — mirrors VitestRunner.resolveTestCommand
 * so the implementer agent can run the exact same command as `tdd:test`.
 */
export function getTestCommand(projectDir: string): string {
  const pm = detectPackageManager(projectDir);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    if (pkg.scripts?.test) return `${pm} run test`;
  } catch { /* ignore */ }
  return `${pm} test`;
}

/**
 * Factory to detect and create the appropriate runner
 */
export function getTestRunner(projectDir: string): TestRunner | null {
  const pkgJsonPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (allDeps.vitest) return new VitestRunner();
    // More runners can be added here (JestRunner, etc)

    return null;
  } catch {
    return null;
  }
}

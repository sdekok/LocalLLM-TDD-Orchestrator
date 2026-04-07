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
 * Base class for common test runner logic.
 */
export abstract class BaseTestRunner implements TestRunner {
  abstract name: string;
  abstract runTests(projectDir: string, timeoutMs: number): Promise<TestResult>;
  abstract runCoverage(projectDir: string, timeoutMs: number): Promise<TestResult>;

  protected async execWithTimeout(command: string, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; passed: boolean }> {
    const logger = getLogger();
    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs });
      return { stdout, stderr, passed: true };
    } catch (err: any) {
      return { 
        stdout: err.stdout || '', 
        stderr: err.stderr || err.message || '', 
        passed: false 
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
 */
export class VitestRunner extends BaseTestRunner {
  name = 'vitest';

  async runTests(projectDir: string, timeoutMs: number): Promise<TestResult> {
    const { stdout, stderr, passed } = await this.execWithTimeout('npx vitest run', projectDir, timeoutMs);
    const output = stdout + '\n' + stderr;
    return {
      passed,
      output,
      metrics: this.parseTestMetrics(output)
    };
  }

  async runCoverage(projectDir: string, timeoutMs: number): Promise<TestResult> {
    // We use --reporter=json-summary so it's easier to parse programmatically
    const { stdout, stderr, passed } = await this.execWithTimeout(
      'npx vitest run --coverage --reporter=default --reporter=json-summary', 
      projectDir, 
      timeoutMs
    );
    const output = stdout + '\n' + stderr;
    return {
      passed,
      output,
      metrics: this.parseTestMetrics(output),
      coverage: this.parseJSONCoverage(projectDir) || this.parseTextCoverage(output)
    };
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

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';

const execAsync = promisify(exec);

export interface GateResult {
  gate: string;
  passed: boolean;
  blocking: boolean;
}

export interface CommitDetails {
  attempt?: number;
  gateResults?: GateResult[];
  reviewerScore?: number;
  reviewerSummary?: string;
  filesChanged?: string[];
  testMetrics?: { total: number; passed: number; failed: number; skipped: number };
  coverageMetrics?: { lines: number; branches: number; functions: number; statements: number };
}

export class Sandbox {
  constructor(private projectDir: string) {}

  /**
   * Sanitize a file path to prevent path traversal.
   */
  sanitizePath(filepath: string): string {
    const resolved = path.resolve(this.projectDir, filepath);
    if (!resolved.startsWith(this.projectDir + path.sep) && resolved !== this.projectDir) {
      throw new Error(`Path traversal detected: ${filepath} resolves to ${resolved}`);
    }
    return resolved;
  }

  /**
   * Create a git branch for sandboxed work.
   */
  async createBranch(branchName: string): Promise<void> {
    const logger = getLogger();
    try {
      await execAsync('git rev-parse --is-inside-work-tree', { cwd: this.projectDir });
    } catch {
      await execAsync('git init && git add -A && git commit -m "Initial commit" --allow-empty', {
        cwd: this.projectDir,
      });
    }

    try {
      await execAsync(`git checkout -b ${branchName}`, { cwd: this.projectDir });
      logger.info(`Created sandbox branch: ${branchName}`);
    } catch {
      await execAsync(`git checkout ${branchName}`, { cwd: this.projectDir });
      logger.info(`Checked out existing branch: ${branchName}`);
    }
  }

  /**
   * Write files to the sandbox (on the current branch).
   * Returns the list of files written.
   */
  writeFiles(files: { filepath: string; content: string }[]): string[] {
    const written: string[] = [];
    for (const f of files) {
      const fullPath = this.sanitizePath(f.filepath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, f.content, 'utf-8');
      written.push(f.filepath);
    }
    return written;
  }

  /**
   * Commit current changes on the sandbox branch.
   * Includes quality gates, test metrics, coverage, and reviewer feedback.
   */
  async commit(message: string, details?: CommitDetails): Promise<void> {
    let fullMessage = message;

    if (details) {
      const lines: string[] = ['', '---', `Attempt: ${details.attempt || 1}`];

      if (details.gateResults) {
        lines.push('', 'Quality Gates:');
        for (const gate of details.gateResults) {
          const icon = gate.passed ? '✅' : (gate.blocking ? '❌' : '⚠️');
          lines.push(`  ${icon} ${gate.gate}${gate.blocking ? ' (blocking)' : ''}`);
        }
      }

      if (details.testMetrics) {
        const t = details.testMetrics;
        lines.push('', `Tests: ${t.passed}/${t.total} passed` +
          (t.failed > 0 ? `, ${t.failed} failed` : '') +
          (t.skipped > 0 ? `, ${t.skipped} skipped` : ''));
      }

      if (details.coverageMetrics) {
        const c = details.coverageMetrics;
        lines.push(`Coverage: ${c.lines}% lines, ${c.branches}% branches, ${c.functions}% functions`);
      }

      if (details.reviewerScore !== undefined) {
        lines.push('', `Reviewer Score: ${details.reviewerScore}/20`);
      }

      if (details.reviewerSummary) {
        lines.push(`Reviewer: ${details.reviewerSummary}`);
      }

      if (details.filesChanged) {
        lines.push('', `Files: ${details.filesChanged.join(', ')}`);
      }

      fullMessage = `${message}\n${lines.join('\n')}`;
    }

    // Use a temp file for the commit message to avoid shell escaping issues
    const msgFile = path.join(this.projectDir, '.git', 'COMMIT_MSG_TMP');
    fs.writeFileSync(msgFile, fullMessage, 'utf-8');
    try {
      await execAsync(`git add -A && git commit -F "${msgFile}"`, {
        cwd: this.projectDir,
      });
    } finally {
      if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
    }
  }

  /**
   * Roll back the sandbox — discard all uncommitted changes and return to main branch.
   */
  async rollback(originalBranch: string): Promise<void> {
    const logger = getLogger();
    try {
      await execAsync('git checkout -- . && git clean -fd', { cwd: this.projectDir });
      await execAsync(`git checkout ${originalBranch}`, { cwd: this.projectDir });
      logger.info(`Rolled back to ${originalBranch}`);
    } catch (err) {
      logger.error(`Rollback failed: ${err}`);
    }
  }

  /**
   * Merge sandbox branch into the original branch, then delete the sandbox branch.
   */
  async mergeAndCleanup(sandboxBranch: string, originalBranch: string): Promise<void> {
    const logger = getLogger();
    await execAsync(`git checkout ${originalBranch}`, { cwd: this.projectDir });
    await execAsync(`git merge ${sandboxBranch} --no-edit`, { cwd: this.projectDir });
    await execAsync(`git branch -d ${sandboxBranch}`, { cwd: this.projectDir });
    logger.info(`Merged ${sandboxBranch} into ${originalBranch}`);
  }

  /**
   * Get the current git branch name.
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: this.projectDir });
      return stdout.trim();
    } catch {
      return 'main';
    }
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import { execFileAsync, sanitizeBranchName, DEFAULT_MAX_BUFFER } from '../utils/exec.js';

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

const EXEC_OPTS = { maxBuffer: DEFAULT_MAX_BUFFER };

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
   * Branch name is validated against a strict allowlist before use.
   */
  async createBranch(branchName: string): Promise<void> {
    const logger = getLogger();
    const safeBranch = sanitizeBranchName(branchName);

    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.projectDir,
        ...EXEC_OPTS,
      });
    } catch {
      // Not a git repo — initialise one
      const gitignorePath = path.join(this.projectDir, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, 'node_modules/\n.env\n.env.*\n*.key\n*.pem\n', 'utf-8');
      }
      await execFileAsync('git', ['init'], { cwd: this.projectDir, ...EXEC_OPTS });
      // Set local identity so the commit works in environments with no global git config (e.g. CI)
      await execFileAsync('git', ['config', 'user.email', 'tdd-workflow@localhost'], { cwd: this.projectDir, ...EXEC_OPTS });
      await execFileAsync('git', ['config', 'user.name', 'TDD Workflow'], { cwd: this.projectDir, ...EXEC_OPTS });
      await execFileAsync('git', ['add', '-A'], { cwd: this.projectDir, ...EXEC_OPTS });
      await execFileAsync('git', ['commit', '-m', 'Initial commit', '--allow-empty'], {
        cwd: this.projectDir,
        ...EXEC_OPTS,
      });
    }

    try {
      await execFileAsync('git', ['checkout', '-b', safeBranch], {
        cwd: this.projectDir,
        ...EXEC_OPTS,
      });
      logger.info(`Created sandbox branch: ${safeBranch}`);
    } catch {
      await execFileAsync('git', ['checkout', safeBranch], {
        cwd: this.projectDir,
        ...EXEC_OPTS,
      });
      logger.info(`Checked out existing branch: ${safeBranch}`);
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

    // Write commit message to a temp file to avoid any shell escaping issues
    const msgFile = path.join(this.projectDir, '.git', 'COMMIT_MSG_TMP');
    fs.writeFileSync(msgFile, fullMessage, 'utf-8');
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: this.projectDir, ...EXEC_OPTS });
      await execFileAsync('git', ['commit', '-F', msgFile], { cwd: this.projectDir, ...EXEC_OPTS });
    } finally {
      if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
    }
  }

  /**
   * Roll back the sandbox — discard all uncommitted changes and return to original branch.
   * originalBranch is validated before use.
   */
  async rollback(originalBranch: string): Promise<void> {
    const logger = getLogger();
    const safeBranch = sanitizeBranchName(originalBranch);
    try {
      // Switch back to the original branch only — no clean, no restore.
      // Any WIP from the failed task remains on its sandbox branch so the
      // user can inspect, debug, or hand it to another agent.
      await execFileAsync('git', ['checkout', safeBranch], { cwd: this.projectDir, ...EXEC_OPTS });
      logger.info(`Returned to ${safeBranch} — sandbox branch preserved for inspection`);
    } catch (err) {
      logger.error(`Could not switch back to ${safeBranch}: ${err}`);
    }
  }

  /**
   * Merge sandbox branch into the original branch, then delete the sandbox branch.
   * Both branch names are validated before use.
   */
  async mergeAndCleanup(sandboxBranch: string, originalBranch: string): Promise<void> {
    const logger = getLogger();
    const safeSandbox = sanitizeBranchName(sandboxBranch);
    const safeOriginal = sanitizeBranchName(originalBranch);
    await execFileAsync('git', ['checkout', safeOriginal], { cwd: this.projectDir, ...EXEC_OPTS });
    await execFileAsync('git', ['merge', safeSandbox, '--no-edit'], { cwd: this.projectDir, ...EXEC_OPTS });
    await execFileAsync('git', ['branch', '-d', safeSandbox], { cwd: this.projectDir, ...EXEC_OPTS });
    logger.info(`Merged ${safeSandbox} into ${safeOriginal}`);
  }

  /**
   * Get the current git branch name.
   * Throws if git is unavailable or not in a repo — callers must store the
   * original branch before switching rather than re-querying later.
   */
  async getCurrentBranch(): Promise<string> {
    const { stdout } = await execFileAsync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: this.projectDir, ...EXEC_OPTS }
    );
    return stdout.trim();
  }
}

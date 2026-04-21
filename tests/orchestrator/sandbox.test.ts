import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Sandbox } from '../../src/orchestrator/sandbox.js';
import { sanitizeBranchName } from '../../src/utils/exec.js';

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', args, { cwd });
}

describe('Sandbox', () => {
  let tmpDir: string;

  function createTmpDir(): string {
    const dir = path.join(os.tmpdir(), `sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ─── sanitizePath ──────────────────────────────────────────────

  describe('sanitizePath', () => {
    it('allows paths within project directory', () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      const result = sandbox.sanitizePath('src/auth/middleware.ts');
      expect(result).toBe(path.join(tmpDir, 'src/auth/middleware.ts'));
    });

    it('rejects path traversal with ..', () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      expect(() => sandbox.sanitizePath('../../etc/passwd')).toThrow('Path traversal detected');
    });

    it('rejects absolute paths outside project', () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      expect(() => sandbox.sanitizePath('/etc/passwd')).toThrow('Path traversal detected');
    });

    it('allows nested directories', () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      const result = sandbox.sanitizePath('src/deep/nested/file.ts');
      expect(result.startsWith(tmpDir)).toBe(true);
    });
  });

  // ─── writeFiles ────────────────────────────────────────────────

  describe('writeFiles', () => {
    it('writes files to the project directory', () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      const written = sandbox.writeFiles([
        { filepath: 'src/test.ts', content: 'export const x = 1;' },
        { filepath: 'tests/test.test.ts', content: 'test("x", () => {});' },
      ]);

      expect(written).toHaveLength(2);
      expect(fs.existsSync(path.join(tmpDir, 'src/test.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'tests/test.test.ts'))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, 'src/test.ts'), 'utf-8')).toBe('export const x = 1;');
    });

    it('creates nested directories automatically', () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      sandbox.writeFiles([{ filepath: 'a/b/c/d.ts', content: 'deep' }]);
      expect(fs.existsSync(path.join(tmpDir, 'a/b/c/d.ts'))).toBe(true);
    });

    it('rejects path traversal in file writes', () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      expect(() => sandbox.writeFiles([{ filepath: '../../bad.ts', content: 'evil' }])).toThrow(
        'Path traversal detected'
      );
    });
  });

  // ─── sanitizeBranchName (unit tests for the exported util) ─────

  describe('sanitizeBranchName', () => {
    it('accepts a standard feature branch name', () => {
      expect(sanitizeBranchName('tdd-workflow/abc12345')).toBe('tdd-workflow/abc12345');
    });

    it('accepts names with underscores and dots', () => {
      expect(sanitizeBranchName('feature/my_feature.v2')).toBe('feature/my_feature.v2');
    });

    it('accepts mixed-case alphanumeric names', () => {
      expect(sanitizeBranchName('Task-42-FooBar')).toBe('Task-42-FooBar');
    });

    it('rejects shell command injection via semicolon', () => {
      expect(() => sanitizeBranchName('main; rm -rf /')).toThrow('Invalid branch name');
    });

    it('rejects shell command injection via backtick', () => {
      expect(() => sanitizeBranchName('main`whoami`')).toThrow('Invalid branch name');
    });

    it('rejects shell command injection via $(...)', () => {
      expect(() => sanitizeBranchName('main$(cat /etc/passwd)')).toThrow('Invalid branch name');
    });

    it('rejects names with spaces', () => {
      expect(() => sanitizeBranchName('feature branch')).toThrow('Invalid branch name');
    });

    it('rejects names with newlines', () => {
      expect(() => sanitizeBranchName('branch\nrm -rf /')).toThrow('Invalid branch name');
    });

    it('rejects names with shell pipe characters', () => {
      expect(() => sanitizeBranchName('branch|id')).toThrow('Invalid branch name');
    });

    it('rejects names with ampersands', () => {
      expect(() => sanitizeBranchName('branch&&evil')).toThrow('Invalid branch name');
    });

    it('rejects empty string', () => {
      expect(() => sanitizeBranchName('')).toThrow();
    });

    it('rejects names starting with a slash', () => {
      expect(() => sanitizeBranchName('/branch')).toThrow('Invalid branch name');
    });

    it('rejects names ending with a slash', () => {
      expect(() => sanitizeBranchName('branch/')).toThrow('Invalid branch name');
    });

    it('rejects names containing double dots (.. traversal)', () => {
      expect(() => sanitizeBranchName('feature/../main')).toThrow('Invalid branch name');
    });
  });

  // ─── createBranch (integration — requires git) ─────────────────

  describe('createBranch', () => {
    it('rejects a branch name with shell metacharacters before running any git command', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      // The error must come from sanitizeBranchName, not from git, proving
      // the validation fires before any subprocess is spawned.
      await expect(sandbox.createBranch('main; echo injected')).rejects.toThrow('Invalid branch name');
    });

    it('rejects a branch name with $() injection', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      await expect(sandbox.createBranch('$(cat /etc/passwd)')).rejects.toThrow('Invalid branch name');
    });

    it('creates a valid branch in a new git repo', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      await sandbox.createBranch('tdd-workflow/test-branch');
      const { stdout } = await import('child_process').then(({ execFile }) => {
        const { promisify } = require('util');
        return promisify(execFile)('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpDir });
      });
      expect((stdout as string).trim()).toBe('tdd-workflow/test-branch');
    });
  });

  // ─── rollback ──────────────────────────────────────────────────

  describe('rollback', () => {
    it('rejects an originalBranch name with shell metacharacters', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      await expect(sandbox.rollback('main; rm -rf /')).rejects.toThrow('Invalid branch name');
    });
  });

  // ─── mergeAndCleanup ───────────────────────────────────────────

  describe('mergeAndCleanup', () => {
    it('rejects a sandboxBranch name with shell metacharacters', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      await expect(sandbox.mergeAndCleanup('branch; evil', 'main')).rejects.toThrow('Invalid branch name');
    });

    it('rejects an originalBranch name with shell metacharacters', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      await expect(sandbox.mergeAndCleanup('feature/x', 'main`id`')).rejects.toThrow('Invalid branch name');
    });
  });

  // ─── getCurrentBranch ──────────────────────────────────────────

  describe('getCurrentBranch', () => {
    it('returns the current branch name in a git repo', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      // Initialise a repo and create a branch
      await sandbox.createBranch('tdd-workflow/get-branch-test');
      const branch = await sandbox.getCurrentBranch();
      expect(branch).toBe('tdd-workflow/get-branch-test');
    });

    it('throws when not in a git repository (no longer silently returns "main")', async () => {
      tmpDir = createTmpDir();
      const sandbox = new Sandbox(tmpDir);
      // tmpDir has no .git directory
      await expect(sandbox.getCurrentBranch()).rejects.toThrow();
    });
  });

  // ─── real-git integration tests ────────────────────────────────────
  //
  // These tests use a real git repo in a temp dir. They exist because unit
  // tests for shell-injection safety don't catch failure modes like merge
  // conflicts, dirty working trees, or branches that already exist from a
  // prior run — all of which show up in production.

  async function initRepo(dir: string) {
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.email', 'tdd-test@localhost');
    await git(dir, 'config', 'user.name', 'TDD Test');
    // Create initial commit so branches have a common ancestor
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    await git(dir, 'add', 'README.md');
    await git(dir, 'commit', '-m', 'initial');
  }

  describe('createBranch (real git)', () => {
    it('creates a new branch from the current HEAD when the branch does not exist yet', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);
      await sandbox.createBranch('tdd-workflow/ep01/WI-1');
      expect(await sandbox.getCurrentBranch()).toBe('tdd-workflow/ep01/WI-1');
    });

    it('recreates the branch from baseBranch when it already exists and keepExisting=false', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);

      // Pre-create a stale branch with a throwaway commit
      await sandbox.createBranch('tdd-workflow/ep01/WI-1');
      fs.writeFileSync(path.join(tmpDir, 'stale.txt'), 'stale WIP');
      await git(tmpDir, 'add', 'stale.txt');
      await git(tmpDir, 'commit', '-m', 'stale');
      const { stdout: staleSha } = await git(tmpDir, 'rev-parse', 'HEAD');

      // Go back to main, then ask createBranch to recreate the task branch (keepExisting=false).
      await git(tmpDir, 'checkout', 'main');
      await sandbox.createBranch('tdd-workflow/ep01/WI-1', { baseBranch: 'main' });

      // The branch should now point at main's HEAD, not the stale commit
      const { stdout: newSha } = await git(tmpDir, 'rev-parse', 'HEAD');
      expect(newSha.trim()).not.toBe(staleSha.trim());
      expect(fs.existsSync(path.join(tmpDir, 'stale.txt'))).toBe(false);
    });

    it('preserves the existing branch when keepExisting=true (resume mode) and merges the base', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);

      // Create a task branch with WIP we want to preserve
      await sandbox.createBranch('tdd-workflow/ep01/WI-1');
      fs.writeFileSync(path.join(tmpDir, 'wip.txt'), 'important WIP');
      await git(tmpDir, 'add', 'wip.txt');
      await git(tmpDir, 'commit', '-m', 'WIP');

      // Simulate the base branch advancing while we were away
      await git(tmpDir, 'checkout', 'main');
      fs.writeFileSync(path.join(tmpDir, 'mainonly.txt'), 'advance');
      await git(tmpDir, 'add', 'mainonly.txt');
      await git(tmpDir, 'commit', '-m', 'main advance');

      // Now request the task branch in resume mode — WIP must still be there AND main's advance.
      await sandbox.createBranch('tdd-workflow/ep01/WI-1', { keepExisting: true, baseBranch: 'main' });
      expect(await sandbox.getCurrentBranch()).toBe('tdd-workflow/ep01/WI-1');
      expect(fs.existsSync(path.join(tmpDir, 'wip.txt'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'mainonly.txt'))).toBe(true);
    });
  });

  describe('commit (real git)', () => {
    it('commits staged changes with a message containing quality-gate details', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);
      await sandbox.createBranch('tdd-workflow/ep01/WI-commit');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1;');

      await sandbox.commit('TDD: Add feature', {
        attempt: 2,
        gateResults: [
          { gate: 'typescript', passed: true, blocking: true },
          { gate: 'tests', passed: true, blocking: true },
        ],
        testMetrics: { total: 5, passed: 5, failed: 0, skipped: 0 },
      });

      const { stdout: log } = await git(tmpDir, 'log', '-1', '--pretty=%B');
      expect(log).toContain('TDD: Add feature');
      expect(log).toContain('Attempt: 2');
      expect(log).toContain('typescript');
      expect(log).toContain('5/5 passed');
    });

    it('is a no-op when there is nothing to commit (implementer already committed)', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);
      await sandbox.createBranch('tdd-workflow/ep01/WI-noop');

      const { stdout: beforeSha } = await git(tmpDir, 'rev-parse', 'HEAD');
      // Working tree is clean — commit() should skip without error.
      await sandbox.commit('TDD: noop', { attempt: 1 });
      const { stdout: afterSha } = await git(tmpDir, 'rev-parse', 'HEAD');
      expect(afterSha.trim()).toBe(beforeSha.trim());
    });
  });

  describe('mergeAndCleanup (real git)', () => {
    it('merges a clean branch into its base and deletes the task branch', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);
      await sandbox.createBranch('tdd-workflow/ep01/WI-merge');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1;');
      await sandbox.commit('TDD: feature', { attempt: 1 });

      await sandbox.mergeAndCleanup('tdd-workflow/ep01/WI-merge', 'main');

      // We're back on main, the file is merged in, and the task branch is gone.
      expect(await sandbox.getCurrentBranch()).toBe('main');
      expect(fs.existsSync(path.join(tmpDir, 'feature.ts'))).toBe(true);
      const { stdout: branches } = await git(tmpDir, 'branch', '--list', 'tdd-workflow/ep01/WI-merge');
      expect(branches.trim()).toBe('');
    });

    it('auto-resolves .tdd-workflow/state.json merge conflicts by preferring the base branch version', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);

      // Both branches will create .tdd-workflow/state.json with different content,
      // triggering an "add/add" conflict on merge. The sandbox treats this as a
      // runtime-file conflict and auto-resolves it with --ours.
      const statePath = '.tdd-workflow/state.json';
      await sandbox.createBranch('tdd-workflow/ep01/WI-conflict');
      fs.mkdirSync(path.join(tmpDir, '.tdd-workflow'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, statePath), '{"taskbranch":true}');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1;');
      await sandbox.commit('TDD: feature with state', { attempt: 1 });

      // Write a different state.json on main
      await git(tmpDir, 'checkout', 'main');
      fs.mkdirSync(path.join(tmpDir, '.tdd-workflow'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, statePath), '{"mainbranch":true}');
      await git(tmpDir, 'add', statePath);
      await git(tmpDir, 'commit', '-m', 'main state');

      // Merge must succeed without throwing — runtime-file conflict is auto-resolved.
      await sandbox.mergeAndCleanup('tdd-workflow/ep01/WI-conflict', 'main');
      expect(await sandbox.getCurrentBranch()).toBe('main');
      // feature.ts should have merged in
      expect(fs.existsSync(path.join(tmpDir, 'feature.ts'))).toBe(true);
      // state.json kept main's version (--ours)
      const stateContent = fs.readFileSync(path.join(tmpDir, statePath), 'utf-8');
      expect(stateContent).toContain('mainbranch');
    });

    it('aborts and throws a clear error when source files have real merge conflicts', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);

      // Both branches modify feature.ts differently → real conflict
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 0;');
      await git(tmpDir, 'add', 'feature.ts');
      await git(tmpDir, 'commit', '-m', 'base feature');

      await sandbox.createBranch('tdd-workflow/ep01/WI-realconflict');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 1; // task');
      await sandbox.commit('TDD: task change', { attempt: 1 });

      await git(tmpDir, 'checkout', 'main');
      fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const x = 2; // main');
      await git(tmpDir, 'add', 'feature.ts');
      await git(tmpDir, 'commit', '-m', 'main change');

      await expect(
        sandbox.mergeAndCleanup('tdd-workflow/ep01/WI-realconflict', 'main')
      ).rejects.toThrow(/Merge conflict/);

      // Merge should be aborted — working tree clean, still on main
      expect(await sandbox.getCurrentBranch()).toBe('main');
      const { stdout: status } = await git(tmpDir, 'status', '--porcelain');
      expect(status.trim()).toBe('');
    });
  });

  describe('ensureOnBaseBranch (real git)', () => {
    it('returns the current branch unchanged when it is not a tdd-workflow/* branch', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);
      const base = await sandbox.ensureOnBaseBranch();
      expect(base).toBe('main');
    });

    it('switches off a tdd-workflow/* task branch to the repo base branch', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);
      await sandbox.createBranch('tdd-workflow/ep01/WI-stuck');
      // Pretend a previous workflow crashed, leaving us on the task branch
      const base = await sandbox.ensureOnBaseBranch();
      expect(base).toBe('main');
      expect(await sandbox.getCurrentBranch()).toBe('main');
    });

    it('switches to the feature branch when one is provided (overrides default base lookup)', async () => {
      tmpDir = createTmpDir();
      await initRepo(tmpDir);
      const sandbox = new Sandbox(tmpDir);
      // Simulate: feature branch exists, a task branch was left checked out.
      await git(tmpDir, 'checkout', '-b', 'feature/ep01-x');
      await sandbox.createBranch('tdd-workflow/ep01/WI-stuck');
      const base = await sandbox.ensureOnBaseBranch('feature/ep01-x');
      expect(base).toBe('feature/ep01-x');
      expect(await sandbox.getCurrentBranch()).toBe('feature/ep01-x');
    });
  });
});

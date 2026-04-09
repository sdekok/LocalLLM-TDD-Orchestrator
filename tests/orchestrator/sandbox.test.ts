import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Sandbox } from '../../src/orchestrator/sandbox.js';
import { sanitizeBranchName } from '../../src/utils/exec.js';

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
});

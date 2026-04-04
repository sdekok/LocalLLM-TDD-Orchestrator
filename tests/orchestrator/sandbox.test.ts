import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Sandbox } from '../../src/orchestrator/sandbox.js';

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
});

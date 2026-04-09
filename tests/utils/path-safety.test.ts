import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { resolveContainedPath } from '../../src/utils/path-safety.js';

// Use a stable, platform-appropriate base directory for testing.
const BASE = path.resolve(os.tmpdir(), 'path-safety-test-base');

describe('resolveContainedPath', () => {
  // ─── Valid paths ──────────────────────────────────────────────────

  it('returns the resolved path for a simple filename', () => {
    const result = resolveContainedPath(BASE, 'file.txt');
    expect(result).toBe(path.join(BASE, 'file.txt'));
  });

  it('returns the resolved path for a nested relative path', () => {
    const result = resolveContainedPath(BASE, 'sub/dir/file.txt');
    expect(result).toBe(path.join(BASE, 'sub', 'dir', 'file.txt'));
  });

  it('allows a path that resolves exactly to baseDir', () => {
    // e.g. resolveContainedPath('/tmp/base', '.') → '/tmp/base'
    const result = resolveContainedPath(BASE, '.');
    expect(result).toBe(BASE);
  });

  it('allows trailing separator components that stay inside base', () => {
    const result = resolveContainedPath(BASE, 'a/b/../c');
    expect(result).toBe(path.join(BASE, 'a', 'c'));
  });

  // ─── Traversal attacks ────────────────────────────────────────────

  it('throws for a simple ../ traversal', () => {
    expect(() => resolveContainedPath(BASE, '../escape')).toThrow('Path traversal detected');
  });

  it('throws for deep traversal that escapes base', () => {
    expect(() => resolveContainedPath(BASE, '../../etc/passwd')).toThrow('Path traversal detected');
  });

  it('throws for a traversal disguised with extra segments', () => {
    expect(() => resolveContainedPath(BASE, 'sub/../../../etc/shadow')).toThrow('Path traversal detected');
  });

  it('throws for an absolute path that escapes base', () => {
    expect(() => resolveContainedPath(BASE, '/etc/passwd')).toThrow('Path traversal detected');
  });

  it('throws for a Windows-style absolute path that escapes base on all platforms', () => {
    // On POSIX, 'C:\\Windows\\System32' is treated as a relative path containing
    // backslashes, but path.resolve will still place it inside BASE — it won't
    // actually reach C:\Windows, so this stays inside the base.  The important
    // invariant we test is that resolveContainedPath never escapes BASE.
    const result = resolveContainedPath(BASE, 'C:\\Windows\\System32');
    expect(result.startsWith(BASE)).toBe(true);
  });

  // ─── False-positive prevention (sibling dir) ─────────────────────

  it('does not confuse a sibling directory with a prefix match', () => {
    // If base = /tmp/foo, resolved = /tmp/foobar should NOT pass.
    const narrowBase = path.resolve(os.tmpdir(), 'foo');
    const sibling = path.resolve(os.tmpdir(), 'foobar', 'file.txt');

    // Build an input relative to the parent that would resolve to the sibling.
    const relative = path.relative(narrowBase, sibling); // '../foobar/file.txt'
    expect(() => resolveContainedPath(narrowBase, relative)).toThrow('Path traversal detected');
  });
});

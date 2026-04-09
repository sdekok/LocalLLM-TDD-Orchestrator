import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractKeywords,
  detectFramework,
  detectTestFramework,
  formatSnapshotForPrompt,
} from '../../src/context/gatherer.js';

// Mock heavy dependencies that require a real project/network
vi.mock('../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/analysis/runner.js', () => ({
  loadCachedAnalysis: vi.fn(() => null),
}));

vi.mock('../../src/analysis/types.js', () => ({
  formatMultiAnalysisForPrompt: vi.fn(() => ''),
}));

// ─── extractKeywords ──────────────────────────────────────────────

describe('extractKeywords', () => {
  it('returns lower-cased unique keywords from a task description', () => {
    const kw = extractKeywords('Add authentication middleware for JWT tokens');
    expect(kw).toContain('authentication');
    expect(kw).toContain('middleware');
    expect(kw).toContain('jwt');
    expect(kw).toContain('tokens');
  });

  it('filters out common stop words', () => {
    const kw = extractKeywords('Add a new feature for the application');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('for');
    expect(kw).not.toContain('a');
  });

  it('filters out short words (length <= 2)', () => {
    const kw = extractKeywords('do it now');
    expect(kw.every(w => w.length > 2)).toBe(true);
  });

  it('strips shell metacharacters from keywords', () => {
    // After extractKeywords, no value should contain shell-dangerous characters
    const kw = extractKeywords('foo; rm -rf / bar`whoami` baz$(id)');
    for (const word of kw) {
      expect(word).not.toMatch(/[;`$|&<>\\]/);
    }
  });

  it('returns unique keywords (no duplicates)', () => {
    const kw = extractKeywords('auth auth authentication auth');
    const unique = new Set(kw);
    expect(kw.length).toBe(unique.size);
  });

  it('returns an empty array for an all-stop-word sentence', () => {
    const kw = extractKeywords('the a an and or but in on at to');
    expect(kw).toHaveLength(0);
  });

  it('handles an empty string', () => {
    expect(extractKeywords('')).toHaveLength(0);
  });

  it('does not produce shell-injectable keywords from adversarial input', () => {
    const adversarial = 'normal "; rm -rf /; echo " end $(cat /etc/passwd) `id`';
    const kw = extractKeywords(adversarial);
    // The regex strips everything non-alphanumeric/whitespace, so all resulting
    // keywords must be safe alphanumeric strings
    for (const word of kw) {
      expect(word).toMatch(/^[a-z0-9]+$/);
    }
  });
});

// ─── detectFramework ──────────────────────────────────────────────

describe('detectFramework', () => {
  it('detects Next.js', () => {
    expect(detectFramework({ next: '^13.0.0' })).toBe('next');
  });
  it('detects Express', () => {
    expect(detectFramework({ express: '^4.0.0' })).toBe('express');
  });
  it('detects NestJS', () => {
    expect(detectFramework({ '@nestjs/core': '^10.0.0' })).toBe('nestjs');
  });
  it('returns null for unknown framework', () => {
    expect(detectFramework({ lodash: '^4.0.0' })).toBeNull();
  });
  it('returns null for empty deps', () => {
    expect(detectFramework({})).toBeNull();
  });
});

// ─── detectTestFramework ──────────────────────────────────────────

describe('detectTestFramework', () => {
  it('detects vitest', () => {
    expect(detectTestFramework({ vitest: '^1.0.0' })).toBe('vitest');
  });
  it('detects jest', () => {
    expect(detectTestFramework({ jest: '^29.0.0' })).toBe('jest');
  });
  it('returns unknown for no test framework', () => {
    expect(detectTestFramework({})).toBe('unknown');
  });
  it('prefers vitest over jest when both present', () => {
    expect(detectTestFramework({ vitest: '^1.0.0', jest: '^29.0.0' })).toBe('vitest');
  });
});

// ─── findExampleFile (via gatherWorkspaceSnapshot) ────────────────
// We test the file-walking logic indirectly by calling gatherWorkspaceSnapshot
// with a real temp directory so no macOS-incompatible `find` commands fire.

describe('findExampleFile: Node-based file walk (no shell find)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gatherer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('finds a test file in src/', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'foo.test.ts'), '// test');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));

    const { gatherWorkspaceSnapshot } = await import('../../src/context/gatherer.js');
    const snapshot = await gatherWorkspaceSnapshot(tmpDir);

    expect(snapshot.existingTestExample).not.toBeNull();
    expect(snapshot.existingTestExample).toContain('foo.test.ts');
  });

  it('finds a source file (non-test) in src/', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'myService.ts'), 'export class MyService {}');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));

    const { gatherWorkspaceSnapshot } = await import('../../src/context/gatherer.js');
    const snapshot = await gatherWorkspaceSnapshot(tmpDir);

    expect(snapshot.existingSourceExample).not.toBeNull();
    expect(snapshot.existingSourceExample).toContain('myService.ts');
  });

  it('returns null for example files when src/ does not exist', async () => {
    // tmpDir has no src/ sub-directory
    fs.rmdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));

    const { gatherWorkspaceSnapshot } = await import('../../src/context/gatherer.js');
    const snapshot = await gatherWorkspaceSnapshot(tmpDir);

    expect(snapshot.existingTestExample).toBeNull();
    expect(snapshot.existingSourceExample).toBeNull();
  });

  it('does not classify a .spec.ts file as a source file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'math.spec.ts'), '// spec');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));

    const { gatherWorkspaceSnapshot } = await import('../../src/context/gatherer.js');
    const snapshot = await gatherWorkspaceSnapshot(tmpDir);

    // The spec file should appear as a test example, not a source example
    expect(snapshot.existingTestExample).toContain('math.spec.ts');
    expect(snapshot.existingSourceExample).toBeNull();
  });
});

// ─── formatSnapshotForPrompt ──────────────────────────────────────

describe('formatSnapshotForPrompt', () => {
  it('includes all snapshot sections', () => {
    const snapshot = {
      projectName: 'my-app',
      language: 'typescript',
      framework: 'express',
      testFramework: 'vitest',
      fileTree: 'src/\n  index.ts',
      packageJson: '{"name":"my-app"}',
      tsconfigJson: null,
      existingTestExample: '// test',
      existingSourceExample: '// source',
      relevantFiles: [{ filepath: 'src/auth.ts', content: 'export const auth = () => {}' }],
      analysisContext: null,
    };

    const prompt = formatSnapshotForPrompt(snapshot);

    expect(prompt).toContain('my-app');
    expect(prompt).toContain('typescript');
    expect(prompt).toContain('express');
    expect(prompt).toContain('vitest');
    expect(prompt).toContain('index.ts');
    expect(prompt).toContain('src/auth.ts');
  });

  it('omits sections that are null or empty', () => {
    const snapshot = {
      projectName: 'minimal',
      language: 'javascript',
      framework: null,
      testFramework: 'unknown',
      fileTree: '',
      packageJson: '',
      tsconfigJson: null,
      existingTestExample: null,
      existingSourceExample: null,
      relevantFiles: [],
      analysisContext: null,
    };

    const prompt = formatSnapshotForPrompt(snapshot);

    expect(prompt).not.toContain('Existing Test Pattern');
    expect(prompt).not.toContain('Existing Source Pattern');
    expect(prompt).not.toContain('Relevant Existing Files');
  });
});

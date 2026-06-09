import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LessonStore, parseLessonCandidates } from '../../src/orchestrator/lessons.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-test-'));
  // Point the "global" store somewhere harmless so the real user config is untouched.
  process.env['TDD_WORKFLOW_CONFIG_DIR'] = path.join(tmpDir, 'global-config');
});

afterEach(() => {
  delete process.env['TDD_WORKFLOW_CONFIG_DIR'];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LessonStore', () => {
  it('starts empty when no files exist', () => {
    const store = LessonStore.load(tmpDir);
    expect(store.count()).toBe(0);
    expect(store.all()).toEqual([]);
  });

  it('adds new candidates with occurrences=1', () => {
    const store = LessonStore.load(tmpDir);
    const result = store.mergeCandidates(
      [{ rule: 'Use a dedicated pg client for transactions', tags: ['postgres'] }],
      'WI-1',
    );
    expect(result).toEqual({ added: 1, reinforced: 0 });
    expect(store.all()[0]).toMatchObject({ occurrences: 1, sources: ['WI-1'] });
  });

  it('reinforces an existing lesson from a different task', () => {
    const store = LessonStore.load(tmpDir);
    store.mergeCandidates([{ id: 'pg-client', rule: 'Use a dedicated pg client' }], 'WI-1');
    const result = store.mergeCandidates([{ id: 'pg-client', rule: 'Use a dedicated pg client' }], 'WI-2');
    expect(result).toEqual({ added: 0, reinforced: 1 });
    expect(store.all()[0]!.occurrences).toBe(2);
  });

  it('does not inflate occurrences when the same task re-reports a lesson', () => {
    const store = LessonStore.load(tmpDir);
    store.mergeCandidates([{ id: 'pg-client', rule: 'Use a dedicated pg client' }], 'WI-1');
    const result = store.mergeCandidates([{ id: 'pg-client', rule: 'Use a dedicated pg client' }], 'WI-1');
    expect(result).toEqual({ added: 0, reinforced: 0 });
    expect(store.all()[0]!.occurrences).toBe(1);
  });

  it('matches by normalized rule text when ids differ', () => {
    const store = LessonStore.load(tmpDir);
    store.mergeCandidates([{ id: 'a', rule: 'Always use UTC date math' }], 'WI-1');
    store.mergeCandidates([{ id: 'b', rule: 'always use utc date math' }], 'WI-2');
    expect(store.count()).toBe(1);
    expect(store.all()[0]!.occurrences).toBe(2);
  });

  it('persists and reloads from the project store', () => {
    const store = LessonStore.load(tmpDir);
    store.mergeCandidates([{ rule: 'Scope integration-test cleanup to the test user', tags: ['testing'] }], 'WI-3');
    store.save();
    const reloaded = LessonStore.load(tmpDir);
    expect(reloaded.count()).toBe(1);
    expect(reloaded.all()[0]!.rule).toContain('Scope integration-test cleanup');
  });

  it('only injects lessons with 2+ occurrences (or confirmed)', () => {
    const store = LessonStore.load(tmpDir);
    store.mergeCandidates([{ id: 'once', rule: 'Seen once', tags: [] }], 'WI-1');
    store.mergeCandidates([{ id: 'twice', rule: 'Seen twice', tags: [] }], 'WI-1');
    store.mergeCandidates([{ id: 'twice', rule: 'Seen twice', tags: [] }], 'WI-2');
    const selected = store.selectForPrompt('any task');
    expect(selected.map(l => l.id)).toEqual(['twice']);
  });

  it('ranks tag-matched lessons higher', () => {
    const store = LessonStore.load(tmpDir);
    for (const taskId of ['WI-1', 'WI-2']) {
      store.mergeCandidates([
        { id: 'pg-lesson', rule: 'Postgres rule', tags: ['postgres'] },
        { id: 'flutter-lesson', rule: 'Flutter rule', tags: ['flutter'] },
      ], taskId);
    }
    const selected = store.selectForPrompt('Implement the postgres outbox consumer', 1);
    expect(selected[0]!.id).toBe('pg-lesson');
  });

  it('forget removes a lesson', () => {
    const store = LessonStore.load(tmpDir);
    store.mergeCandidates([{ id: 'gone', rule: 'To be removed' }], 'WI-1');
    expect(store.forget('gone')).toBe(true);
    expect(store.forget('gone')).toBe(false);
    expect(store.count()).toBe(0);
  });

  it('renders an empty string for no lessons and a numbered list otherwise', () => {
    expect(LessonStore.renderForPrompt([])).toBe('');
    const rendered = LessonStore.renderForPrompt([
      { id: 'a', rule: 'Rule one', detail: 'Why it matters', tags: [], occurrences: 3, sources: [], lastSeen: '2026-06-01' },
    ]);
    expect(rendered).toContain('Lessons from previous reviews');
    expect(rendered).toContain('1. Rule one — Why it matters');
  });

  it('merges the global store with project taking precedence', () => {
    const globalDir = path.join(tmpDir, 'global-config');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'lessons.json'), JSON.stringify({
      version: 1,
      lessons: [
        { id: 'shared', rule: 'Global version', tags: [], occurrences: 5, sources: [], lastSeen: '2026-01-01' },
        { id: 'global-only', rule: 'Only global', tags: [], occurrences: 2, sources: [], lastSeen: '2026-01-01' },
      ],
    }));
    const projectDir = path.join(tmpDir, '.tdd-workflow');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'lessons.json'), JSON.stringify({
      version: 1,
      lessons: [
        { id: 'shared', rule: 'Project version', tags: [], occurrences: 3, sources: [], lastSeen: '2026-06-01' },
      ],
    }));

    const store = LessonStore.load(tmpDir);
    expect(store.count()).toBe(2);
    expect(store.all().find(l => l.id === 'shared')!.rule).toBe('Project version');
  });
});

describe('parseLessonCandidates', () => {
  it('parses a plain JSON array', () => {
    const out = parseLessonCandidates('[{"id":"x","rule":"Do the thing","tags":["a"]}]');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'x', rule: 'Do the thing' });
  });

  it('strips markdown fences and surrounding prose', () => {
    const out = parseLessonCandidates('Here are the lessons:\n```json\n[{"rule":"Use UTC"}]\n```\nDone.');
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe('Use UTC');
  });

  it('returns [] for garbage, empty arrays, and non-arrays', () => {
    expect(parseLessonCandidates('no json here')).toEqual([]);
    expect(parseLessonCandidates('[]')).toEqual([]);
    expect(parseLessonCandidates('{"rule":"object not array"}')).toEqual([]);
    expect(parseLessonCandidates('')).toEqual([]);
  });

  it('drops entries without a rule and caps at 5', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({ rule: `Rule ${i}` }));
    const out = parseLessonCandidates(JSON.stringify([{ id: 'no-rule' }, ...entries]));
    expect(out).toHaveLength(5);
    expect(out[0]!.rule).toBe('Rule 0');
  });
});

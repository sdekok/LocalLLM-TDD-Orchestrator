import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parsePlanArgs,
  listExistingEpics,
  readPriorRequest,
} from '../../../src/interfaces/pi/plan-helpers.js';

describe('parsePlanArgs', () => {
  it('returns an empty result for blank input', () => {
    const r = parsePlanArgs('');
    expect(r.subcommand).toBeNull();
    expect(r.rest).toBe('');
    expect(r.replace).toBe(false);
    expect(r.brownfield).toBe(false);
    expect(r.fromEpic).toBeUndefined();
  });

  it('treats free-form text as the description (no subcommand)', () => {
    const r = parsePlanArgs('build a chat app with auth');
    expect(r.subcommand).toBeNull();
    expect(r.rest).toBe('build a chat app with auth');
  });

  it('recognizes the `list` subcommand', () => {
    const r = parsePlanArgs('list');
    expect(r.subcommand).toBe('list');
    expect(r.rest).toBe('');
  });

  it('recognizes `show <epic>` and captures the target', () => {
    const r = parsePlanArgs('show epic-03');
    expect(r.subcommand).toBe('show');
    expect(r.target).toBe('epic-03');
  });

  it('recognizes `revise <feedback>` and captures the feedback as rest', () => {
    const r = parsePlanArgs('revise switch to postgres');
    expect(r.subcommand).toBe('revise');
    expect(r.rest).toBe('switch to postgres');
  });

  it('extracts --replace anywhere in the arg list', () => {
    const r = parsePlanArgs('--replace build a thing');
    expect(r.replace).toBe(true);
    expect(r.rest).toBe('build a thing');
  });

  it('extracts --brownfield', () => {
    const r = parsePlanArgs('--brownfield rework auth');
    expect(r.brownfield).toBe(true);
    expect(r.rest).toBe('rework auth');
  });

  it('extracts --from-epic and its value', () => {
    const r = parsePlanArgs('--from-epic 02 add caching layer');
    expect(r.fromEpic).toBe('02');
    expect(r.rest).toBe('add caching layer');
  });

  it('allows flags to appear after the description tokens', () => {
    const r = parsePlanArgs('add caching --from-epic 02 --brownfield');
    expect(r.fromEpic).toBe('02');
    expect(r.brownfield).toBe(true);
    expect(r.rest).toBe('add caching');
  });

  it('keeps free-form text after a subcommand as rest', () => {
    const r = parsePlanArgs('revise --brownfield use redis instead of memcached');
    expect(r.subcommand).toBe('revise');
    expect(r.brownfield).toBe(true);
    expect(r.rest).toBe('use redis instead of memcached');
  });

  it('is case-insensitive on the subcommand head', () => {
    expect(parsePlanArgs('LIST').subcommand).toBe('list');
    expect(parsePlanArgs('Show epic-01').subcommand).toBe('show');
    expect(parsePlanArgs('REVISE feedback').subcommand).toBe('revise');
  });

  it('handles --from-epic without a value gracefully', () => {
    const r = parsePlanArgs('--from-epic');
    expect(r.fromEpic).toBeUndefined();
  });
});

describe('listExistingEpics', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-helpers-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty array when WorkItems/ is missing', () => {
    expect(listExistingEpics(tmp)).toEqual([]);
  });

  it('returns an empty array when WorkItems/ exists but contains no epic files', () => {
    fs.mkdirSync(path.join(tmp, 'WorkItems'));
    fs.writeFileSync(path.join(tmp, 'WorkItems', '_overview.md'), '# Project Overview\n');
    fs.writeFileSync(path.join(tmp, 'WorkItems', 'README.md'), 'not an epic');
    expect(listExistingEpics(tmp)).toEqual([]);
  });

  it('parses epic files and counts work items', () => {
    const dir = path.join(tmp, 'WorkItems');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'epic-01-auth.md'),
      '# Epic: User Authentication\n\n## Summary\nLogin flows.\n\n## Work Items\n\n### WI-1: Email login\n\n### WI-2: OAuth\n',
    );
    fs.writeFileSync(
      path.join(dir, 'epic-02-billing.md'),
      '# Epic: Billing\n\n## Work Items\n\n### WI-1: Stripe integration\n',
    );

    const epics = listExistingEpics(tmp);
    expect(epics).toHaveLength(2);
    expect(epics[0]).toEqual({
      id: '01',
      slug: 'auth',
      title: 'User Authentication',
      workItemCount: 2,
    });
    expect(epics[1]).toMatchObject({ id: '02', slug: 'billing', title: 'Billing', workItemCount: 1 });
  });

  it('sorts epics by numeric index, not lexicographic filename order', () => {
    const dir = path.join(tmp, 'WorkItems');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'epic-10-z.md'), '# Epic: Tenth\n');
    fs.writeFileSync(path.join(dir, 'epic-02-a.md'), '# Epic: Second\n');
    fs.writeFileSync(path.join(dir, 'epic-01-b.md'), '# Epic: First\n');

    const epics = listExistingEpics(tmp);
    expect(epics.map(e => e.id)).toEqual(['01', '02', '10']);
  });

  it('falls back to the slug when no Epic title heading is present', () => {
    const dir = path.join(tmp, 'WorkItems');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'epic-01-stub.md'), 'no title heading here');

    const epics = listExistingEpics(tmp);
    expect(epics[0]).toMatchObject({ id: '01', slug: 'stub', title: 'stub' });
  });
});

describe('readPriorRequest', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-helpers-prior-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when the request file is missing', () => {
    expect(readPriorRequest(tmp)).toBeNull();
  });

  it('parses a well-formed _request.json', () => {
    const dir = path.join(tmp, '.tdd-workflow', 'planning');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '_request.json'),
      JSON.stringify({ request: 'build a chat app', mode: 'append', timestamp: '2026-05-24T12:00:00Z' }),
    );

    const r = readPriorRequest(tmp);
    expect(r).toEqual({ request: 'build a chat app', mode: 'append', timestamp: '2026-05-24T12:00:00Z' });
  });

  it('returns null for malformed JSON instead of throwing', () => {
    const dir = path.join(tmp, '.tdd-workflow', 'planning');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '_request.json'), 'this is not json');

    expect(readPriorRequest(tmp)).toBeNull();
  });
});

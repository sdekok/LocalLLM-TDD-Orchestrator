import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync as realExecSync } from 'child_process';
import {
  completeTddArgs,
  completeReviewArgs,
  completeResearchArgs,
  completePlanArgs,
} from '../../../src/interfaces/pi/autocomplete.js';

// Mock git branch lookup so /review autocomplete tests don't depend on the host
// repo. The real impl is execSync('git branch …') from child_process.
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: vi.fn((cmd: string, opts: any) => {
      if (typeof cmd === 'string' && cmd.startsWith('git branch')) {
        return 'main\nfeature/auth\nfix/db\n';
      }
      return actual.execSync(cmd, opts);
    }),
  };
});

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-autocomplete-'));
}

function seedEpics(cwd: string): void {
  const dir = path.join(cwd, 'WorkItems');
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'epic-01-auth.md'),
    '# Epic: User Authentication\n\n## Summary\nAuth flows.\n\n## Work Items\n\n### WI-1: Email login\n\n### WI-2: OAuth\n',
  );
  fs.writeFileSync(
    path.join(dir, 'epic-02-billing.md'),
    '# Epic: Billing\n\n## Summary\nStripe.\n\n## Work Items\n\n### WI-1: Setup\n',
  );
}

describe('completeTddArgs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
    seedEpics(tmp);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('suggests epic IDs at position 0', () => {
    const items = completeTddArgs(tmp, '');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value).sort()).toEqual(['01', '02']);
  });

  it('filters epic suggestions by typed prefix', () => {
    const items = completeTddArgs(tmp, '0');
    expect(items!.map(i => i.value).sort()).toEqual(['01', '02']);

    const more = completeTddArgs(tmp, '01');
    expect(more!.map(i => i.value)).toEqual(['01']);
  });

  it('suggests subcommands after an epic + space', () => {
    const items = completeTddArgs(tmp, '01 ');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value).sort()).toEqual(['continue', 'resume', 'retry', 'task']);
  });

  it('suggests work-item IDs after `task`', () => {
    const items = completeTddArgs(tmp, '01 task ');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value).sort()).toEqual(['WI-1', 'WI-2']);
  });

  it('suggests post-task modes after a work-item ID', () => {
    const items = completeTddArgs(tmp, '01 task WI-1 ');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value).sort()).toEqual(['complete', 'done', 'resume', 'retry']);
  });
});

describe('completeReviewArgs', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('suggests scope tokens at position 0', () => {
    const items = completeReviewArgs(tmp, '');
    expect(items!.map(i => i.value).sort()).toEqual(['all', 'branch', 'uncommitted']);
  });

  it('lists git branches after `branch`', () => {
    const items = completeReviewArgs(tmp, 'branch ');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value)).toEqual(['main', 'feature/auth', 'fix/db']);
  });

  it('filters branches by typed prefix', () => {
    const items = completeReviewArgs(tmp, 'branch fix');
    expect(items!.map(i => i.value)).toEqual(['fix/db']);
  });
});

describe('completeResearchArgs', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkTmp(); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns null for free-form topic text', () => {
    expect(completeResearchArgs(tmp, 'how do vector databases work')).toBeNull();
  });

  it('suggests flags after `-`', () => {
    const items = completeResearchArgs(tmp, '--');
    expect(items!.map(i => i.value).sort()).toEqual(['--bg', '--resume', '--shallow', '--time']);
  });

  it('lists research dirs after `--resume `', () => {
    const researchDir = path.join(tmp, 'Research', '2026-05-24-vector-dbs');
    fs.mkdirSync(researchDir, { recursive: true });
    fs.writeFileSync(path.join(researchDir, 'state.json'), '{}');

    const items = completeResearchArgs(tmp, '--resume ');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value)).toEqual(['Research/2026-05-24-vector-dbs']);
  });
});

describe('completePlanArgs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkTmp();
    seedEpics(tmp);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('suggests subcommands at position 0', () => {
    const items = completePlanArgs(tmp, '');
    expect(items!.map(i => i.value).sort()).toEqual(['list', 'revise', 'show']);
  });

  it('filters subcommand suggestions by prefix', () => {
    const items = completePlanArgs(tmp, 'rev');
    expect(items!.map(i => i.value)).toEqual(['revise']);
  });

  it('suggests epic IDs after `show`', () => {
    const items = completePlanArgs(tmp, 'show ');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value).sort()).toEqual(['01', '02']);
  });

  it('suggests flags after `-`', () => {
    const items = completePlanArgs(tmp, '--');
    expect(items!.map(i => i.value).sort()).toEqual(['--brownfield', '--from-epic', '--replace']);
  });

  it('suggests epic IDs after `--from-epic `', () => {
    const items = completePlanArgs(tmp, '--from-epic ');
    expect(items).not.toBeNull();
    expect(items!.map(i => i.value).sort()).toEqual(['01', '02']);
  });

  it('returns null inside free-form description text', () => {
    expect(completePlanArgs(tmp, 'build a chat app with')).toBeNull();
  });
});

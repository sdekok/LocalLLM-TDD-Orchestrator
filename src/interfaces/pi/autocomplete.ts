import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { EpicLoader } from '../../orchestrator/epic-loader.js';
import { findResearchDirs } from '../../agents/researcher.js';

interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

// argumentPrefix is the raw text after the command name (everything the user has
// typed after `/tdd `, `/review `, `/research `). We tokenize on whitespace and
// decide what to suggest from the position.

function listEpicFiles(cwd: string): { id: string; title: string; filename: string }[] {
  const dir = path.join(cwd, 'WorkItems');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  return files.map(f => {
    const idMatch = f.match(/^epic-(\d+)/);
    const id = idMatch?.[1] ?? f.replace(/\.md$/, '');
    let title = f.replace(/\.md$/, '');
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const m = content.match(/^# Epic:\s*(.*)$/m);
      if (m?.[1]) title = m[1].trim();
    } catch { /* best-effort */ }
    return { id, title, filename: f };
  });
}

function listGitBranches(cwd: string): string[] {
  try {
    const out = execSync('git branch --format=%(refname:short)', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function filterByPrefix(items: AutocompleteItem[], prefix: string): AutocompleteItem[] {
  if (!prefix) return items;
  const lower = prefix.toLowerCase();
  return items.filter(it =>
    it.value.toLowerCase().startsWith(lower) ||
    it.label.toLowerCase().includes(lower)
  );
}

export function completeTddArgs(cwd: string, argumentPrefix: string): AutocompleteItem[] | null {
  const trailingSpace = /\s$/.test(argumentPrefix);
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);

  // Position 0: epic ref
  if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
    const epics = listEpicFiles(cwd);
    return filterByPrefix(
      epics.map(e => ({ value: e.id, label: e.id, description: e.title })),
      tokens[0] ?? ''
    );
  }

  // Position 1: subcommand
  if ((tokens.length === 1 && trailingSpace) || (tokens.length === 2 && !trailingSpace)) {
    const items: AutocompleteItem[] = [
      { value: 'retry',    label: 'retry',    description: 'Retry failed tasks (clear reviewer feedback)' },
      { value: 'resume',   label: 'resume',   description: 'Resume failed tasks (preserve feedback)' },
      { value: 'continue', label: 'continue', description: 'Continue, skipping failed tasks' },
      { value: 'task',     label: 'task',     description: 'Run a single task by ID' },
    ];
    return filterByPrefix(items, tokens[1] ?? '');
  }

  // Position 2: task ID (only after `task`) or modifier after task ID
  const sub = tokens[1]?.toLowerCase();
  if (sub === 'task') {
    if ((tokens.length === 2 && trailingSpace) || (tokens.length === 3 && !trailingSpace)) {
      // Suggest WI IDs from the referenced epic
      try {
        const loader = new EpicLoader(cwd);
        const epicPath = loader.findEpic(tokens[0]!);
        if (!epicPath) return [];
        const epic = loader.parseEpic(epicPath);
        return filterByPrefix(
          epic.workItems.map(wi => ({
            value: wi.id,
            label: wi.id,
            description: wi.title,
          })),
          tokens[2] ?? ''
        );
      } catch {
        return [];
      }
    }
    // Position 3: post-task mode
    if ((tokens.length === 3 && trailingSpace) || (tokens.length === 4 && !trailingSpace)) {
      const items: AutocompleteItem[] = [
        { value: 'retry',    label: 'retry',    description: 'Reset feedback and re-run' },
        { value: 'resume',   label: 'resume',   description: 'Preserve feedback and re-run' },
        { value: 'done',     label: 'done',     description: 'Mark task as externally completed' },
        { value: 'complete', label: 'complete', description: 'Same as done' },
      ];
      return filterByPrefix(items, tokens[3] ?? '');
    }
  }

  return null;
}

export function completeReviewArgs(cwd: string, argumentPrefix: string): AutocompleteItem[] | null {
  const trailingSpace = /\s$/.test(argumentPrefix);
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);

  // Position 0: scope
  if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
    const items: AutocompleteItem[] = [
      { value: 'uncommitted', label: 'uncommitted', description: 'Review staged + unstaged changes' },
      { value: 'all',         label: 'all',         description: 'Review entire current state' },
      { value: 'branch',      label: 'branch',      description: 'Review a branch (next arg)' },
    ];
    return filterByPrefix(items, tokens[0] ?? '');
  }

  // After `branch`: list git branches
  if (tokens[0]?.toLowerCase() === 'branch') {
    if ((tokens.length === 1 && trailingSpace) || (tokens.length === 2 && !trailingSpace)) {
      return filterByPrefix(
        listGitBranches(cwd).map(b => ({ value: b, label: b })),
        tokens[1] ?? ''
      );
    }
  }

  return null;
}

export function completePlanArgs(cwd: string, argumentPrefix: string): AutocompleteItem[] | null {
  const trailingSpace = /\s$/.test(argumentPrefix);
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1] ?? '';

  // After `--from-epic ` → epic IDs
  if (last === '--from-epic' && trailingSpace) {
    return listEpicFiles(cwd).map(e => ({ value: e.id, label: e.id, description: e.title }));
  }
  if (tokens.length >= 2 && tokens[tokens.length - 2] === '--from-epic' && !trailingSpace) {
    return filterByPrefix(
      listEpicFiles(cwd).map(e => ({ value: e.id, label: e.id, description: e.title })),
      last,
    );
  }

  // `show <epic>` completions
  const hasShow = tokens.some(t => t.toLowerCase() === 'show');
  if (hasShow) {
    const showIdx = tokens.findIndex(t => t.toLowerCase() === 'show');
    const isAtTarget =
      (tokens.length === showIdx + 1 && trailingSpace) ||
      (tokens.length === showIdx + 2 && !trailingSpace);
    if (isAtTarget) {
      return filterByPrefix(
        listEpicFiles(cwd).map(e => ({ value: e.id, label: e.id, description: e.title })),
        tokens[showIdx + 1] ?? '',
      );
    }
  }

  // Flag completion when the user types `-`
  if (last.startsWith('-')) {
    const flags: AutocompleteItem[] = [
      { value: '--replace',    label: '--replace',    description: 'Overwrite existing epics (default: append)' },
      { value: '--brownfield', label: '--brownfield', description: 'Tell the planner this is an existing codebase' },
      { value: '--from-epic',  label: '--from-epic',  description: 'Extend a specific existing epic' },
    ];
    return filterByPrefix(flags, last);
  }

  // First position: subcommand suggestions (only when nothing else has been typed)
  if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
    const items: AutocompleteItem[] = [
      { value: 'list',   label: 'list',   description: 'List existing epics in WorkItems/' },
      { value: 'show',   label: 'show',   description: 'Display an existing epic' },
      { value: 'revise', label: 'revise', description: 'Re-run planning with your latest feedback' },
    ];
    return filterByPrefix(items, tokens[0] ?? '');
  }

  return null;
}

export function completeResearchArgs(cwd: string, argumentPrefix: string): AutocompleteItem[] | null {
  const trailingSpace = /\s$/.test(argumentPrefix);
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1] ?? '';

  // If the user just typed `--resume ` (with space), suggest research dirs
  if (last === '--resume' && trailingSpace) {
    const dirs = findResearchDirs(cwd);
    return dirs.map(d => ({ value: d, label: d }));
  }
  // Or `--resume <partial>` (no trailing space, last token starting with non-flag)
  if (tokens.length >= 2 && tokens[tokens.length - 2] === '--resume' && !trailingSpace) {
    const dirs = findResearchDirs(cwd);
    return filterByPrefix(dirs.map(d => ({ value: d, label: d })), last);
  }

  // Otherwise, only suggest flags when the last token starts with `-`
  if (last.startsWith('-')) {
    const flags: AutocompleteItem[] = [
      { value: '--bg',      label: '--bg',      description: 'Run in background' },
      { value: '--shallow', label: '--shallow', description: 'Single-pass research' },
      { value: '--time',    label: '--time',    description: 'Time limit in minutes' },
      { value: '--resume',  label: '--resume',  description: 'Continue a previous session' },
    ];
    return filterByPrefix(flags, last);
  }

  return null;
}

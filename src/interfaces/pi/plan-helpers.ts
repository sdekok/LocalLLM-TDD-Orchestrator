import * as fs from 'fs';
import * as path from 'path';

export interface ParsedPlanArgs {
  subcommand: 'list' | 'show' | 'revise' | null;
  /** For `show`: the epic ref. */
  target: string;
  /** Remaining free-form text (description, feedback). */
  rest: string;
  replace: boolean;
  brownfield: boolean;
  /** Epic ref for --from-epic. */
  fromEpic: string | undefined;
}

/**
 * Parse `/plan` args into subcommand + flags + free text. Grammar:
 *   list                          → list existing epics
 *   show <epic>                   → display an epic
 *   revise [feedback...]          → re-run with the saved request + feedback
 *   [--replace] [--brownfield] [--from-epic <id>] <description...>
 *
 * Flags can appear in any position; everything else after subcommand stripping
 * becomes `rest`.
 */
export function parsePlanArgs(args: string): ParsedPlanArgs {
  const parsed: ParsedPlanArgs = {
    subcommand: null,
    target: '',
    rest: '',
    replace: false,
    brownfield: false,
    fromEpic: undefined,
  };
  if (!args.trim()) return parsed;

  const tokens = args.trim().split(/\s+/);
  const consumed = new Set<number>();

  // First-pass: extract flags. Mark consumed positions so they don't leak into rest.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === '--replace') { parsed.replace = true; consumed.add(i); }
    else if (t === '--brownfield') { parsed.brownfield = true; consumed.add(i); }
    else if (t === '--from-epic') {
      consumed.add(i);
      if (i + 1 < tokens.length) {
        parsed.fromEpic = tokens[i + 1];
        consumed.add(i + 1);
      }
    }
  }

  const remaining = tokens.filter((_, i) => !consumed.has(i));
  if (remaining.length === 0) return parsed;

  const head = remaining[0]!.toLowerCase();
  if (head === 'list') {
    parsed.subcommand = 'list';
    parsed.rest = remaining.slice(1).join(' ');
    return parsed;
  }
  if (head === 'show') {
    parsed.subcommand = 'show';
    parsed.target = remaining[1] ?? '';
    parsed.rest = remaining.slice(2).join(' ');
    return parsed;
  }
  if (head === 'revise') {
    parsed.subcommand = 'revise';
    parsed.rest = remaining.slice(1).join(' ');
    return parsed;
  }

  parsed.rest = remaining.join(' ');
  return parsed;
}

export interface ExistingEpicSummary {
  id: string;
  title: string;
  slug: string;
  workItemCount: number;
}

/**
 * Read the WorkItems/ directory and return one summary per `epic-NN-slug.md`
 * file. Sorted by index ascending. Silently skips files that cannot be parsed.
 */
export function listExistingEpics(cwd: string): ExistingEpicSummary[] {
  const dir = path.join(cwd, 'WorkItems');
  if (!fs.existsSync(dir)) return [];
  const out: ExistingEpicSummary[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^epic-(\d+)-(.+)\.md$/);
    if (!m) continue;
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8');
      const titleMatch = content.match(/^# Epic:\s*(.*)$/m);
      const workItemCount = (content.match(/^### (WI-\d+|[\w-]+):/gm) || []).length;
      out.push({
        id: m[1]!,
        slug: m[2]!,
        title: titleMatch?.[1]?.trim() ?? m[2]!,
        workItemCount,
      });
    } catch { /* skip unreadable epic files */ }
  }
  out.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  return out;
}

export interface PriorRequest {
  request: string;
  mode: string;
  timestamp: string;
}

/**
 * Load the most recent `/plan` request from .tdd-workflow/planning/_request.json.
 * Returns null when no prior run is recorded or the file is malformed.
 */
export function readPriorRequest(cwd: string): PriorRequest | null {
  const p = path.join(cwd, '.tdd-workflow', 'planning', '_request.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

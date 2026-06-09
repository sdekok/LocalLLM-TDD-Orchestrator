import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';

/**
 * Self-learning lesson store.
 *
 * After each task with at least one feedback round, an extraction step distills
 * the reviewer/gate feedback into short, general, imperative rules ("lessons").
 * Lessons that recur across tasks (occurrences >= 2, or user-confirmed) are
 * injected into the implementer's first-turn prompt so the same mistakes stop
 * costing review iterations.
 *
 * Storage:
 *   - project: <projectDir>/.tdd-workflow/lessons.json   (written by default)
 *   - global:  ~/.config/tdd-workflow/lessons.json        (read + merged; project wins on id conflict)
 */

export interface Lesson {
  /** Stable kebab-case slug, e.g. "pg-transactions-dedicated-client". */
  id: string;
  /** One-sentence imperative rule, general enough to apply beyond one task. */
  rule: string;
  /** Optional 1–2 sentence elaboration (the "why" or the concrete fix pattern). */
  detail?: string;
  /** Match keywords: languages, gates, libraries, path fragments ("postgres", "zod", "testing"…). */
  tags: string[];
  /** Number of distinct tasks/rounds this pattern was observed in. */
  occurrences: number;
  /** Task IDs where it was seen (capped). */
  sources: string[];
  /** ISO date of the most recent observation. */
  lastSeen: string;
  /** User-curated lessons are always eligible for injection regardless of occurrences. */
  confirmed?: boolean;
}

export interface LessonCandidate {
  id?: string;
  rule: string;
  detail?: string;
  tags?: string[];
}

interface LessonsFile {
  version: 1;
  lessons: Lesson[];
}

const MAX_LESSONS = 100;
const MAX_SOURCES_PER_LESSON = 10;
/** Lessons below this occurrence count are stored but not injected (unless confirmed). */
export const INJECT_MIN_OCCURRENCES = 2;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
}

function globalLessonsPath(): string {
  const configDir = process.env['TDD_WORKFLOW_CONFIG_DIR']
    ?? path.join(os.homedir(), '.config', 'tdd-workflow');
  return path.join(configDir, 'lessons.json');
}

function readLessonsFile(filePath: string): Lesson[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as LessonsFile;
    if (!Array.isArray(parsed.lessons)) return [];
    return parsed.lessons.filter(l => l && typeof l.id === 'string' && typeof l.rule === 'string');
  } catch (err) {
    getLogger().warn(`[Lessons] Could not read ${filePath}: ${err}`);
    return [];
  }
}

export class LessonStore {
  private constructor(
    private readonly projectPath: string,
    private lessons: Lesson[],
  ) {}

  /** Load project + global lessons. Project entries win on id conflict. */
  static load(projectDir: string): LessonStore {
    const projectPath = path.join(projectDir, '.tdd-workflow', 'lessons.json');
    const project = readLessonsFile(projectPath);
    const global = readLessonsFile(globalLessonsPath());
    const byId = new Map<string, Lesson>();
    for (const l of global) byId.set(l.id, l);
    for (const l of project) byId.set(l.id, l);
    return new LessonStore(projectPath, [...byId.values()]);
  }

  all(): Lesson[] {
    return [...this.lessons].sort((a, b) => b.occurrences - a.occurrences || b.lastSeen.localeCompare(a.lastSeen));
  }

  count(): number {
    return this.lessons.length;
  }

  /**
   * Merge extraction candidates into the store. Matches by id, then by
   * normalized rule text; matched lessons get occurrences++ and updated
   * lastSeen, unmatched ones are added with occurrences = 1.
   * Returns counts for reporting.
   */
  mergeCandidates(candidates: LessonCandidate[], sourceTaskId: string): { added: number; reinforced: number } {
    const today = new Date().toISOString().slice(0, 10);
    let added = 0;
    let reinforced = 0;

    for (const c of candidates) {
      if (!c.rule?.trim()) continue;
      const id = (c.id && slugify(c.id)) || slugify(c.rule);
      if (!id) continue;
      const normRule = c.rule.trim().toLowerCase();
      const existing = this.lessons.find(l => l.id === id || l.rule.trim().toLowerCase() === normRule);

      if (existing) {
        // Re-reinforcement from the same task doesn't inflate the count —
        // occurrences measures distinct tasks, not rounds.
        if (!existing.sources.includes(sourceTaskId)) {
          existing.occurrences += 1;
          existing.sources.push(sourceTaskId);
          if (existing.sources.length > MAX_SOURCES_PER_LESSON) existing.sources.shift();
          reinforced++;
        }
        existing.lastSeen = today;
        if (c.detail && !existing.detail) existing.detail = c.detail;
        if (c.tags) existing.tags = [...new Set([...existing.tags, ...c.tags.map(t => t.toLowerCase())])];
      } else {
        const lesson: Lesson = {
          id,
          rule: c.rule.trim(),
          tags: (c.tags ?? []).map(t => t.toLowerCase()),
          occurrences: 1,
          sources: [sourceTaskId],
          lastSeen: today,
        };
        if (c.detail?.trim()) lesson.detail = c.detail.trim();
        this.lessons.push(lesson);
        added++;
      }
    }

    this.prune();
    return { added, reinforced };
  }

  /** Remove a lesson by id. Returns true if it existed. */
  forget(id: string): boolean {
    const before = this.lessons.length;
    this.lessons = this.lessons.filter(l => l.id !== id);
    return this.lessons.length < before;
  }

  /**
   * Pick the lessons most relevant to a task for prompt injection.
   * Eligible: confirmed, or seen in >= INJECT_MIN_OCCURRENCES distinct tasks.
   * Scored by tag match against the task text, then occurrences, then recency.
   */
  selectForPrompt(taskText: string, max = 10): Lesson[] {
    const text = taskText.toLowerCase();
    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return this.lessons
      .filter(l => l.confirmed || l.occurrences >= INJECT_MIN_OCCURRENCES)
      .map(l => {
        const tagHits = l.tags.filter(t => text.includes(t)).length;
        const recencyBonus = l.lastSeen >= cutoff ? 1 : 0;
        return { lesson: l, score: tagHits * 2 + Math.min(l.occurrences, 5) + recencyBonus };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map(s => s.lesson);
  }

  /** Render selected lessons as a prompt section. Empty string when none. */
  static renderForPrompt(lessons: Lesson[]): string {
    if (lessons.length === 0) return '';
    const lines = lessons.map((l, i) => {
      const detail = l.detail ? ` — ${l.detail}` : '';
      return `${i + 1}. ${l.rule}${detail}`;
    });
    return (
      `### Lessons from previous reviews in this codebase\n` +
      `These are recurring reviewer findings — violating them WILL cause a rejection:\n` +
      lines.join('\n')
    );
  }

  /** Persist to the project store (atomic-ish: tmp + rename). */
  save(): void {
    const data: LessonsFile = { version: 1, lessons: this.lessons };
    fs.mkdirSync(path.dirname(this.projectPath), { recursive: true });
    const tmp = `${this.projectPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.projectPath);
  }

  /** Cap the store: drop the weakest (fewest occurrences, oldest) first. Confirmed lessons survive. */
  private prune(): void {
    if (this.lessons.length <= MAX_LESSONS) return;
    const sorted = [...this.lessons].sort((a, b) => {
      if (!!a.confirmed !== !!b.confirmed) return a.confirmed ? -1 : 1;
      return b.occurrences - a.occurrences || b.lastSeen.localeCompare(a.lastSeen);
    });
    this.lessons = sorted.slice(0, MAX_LESSONS);
  }
}

/**
 * System prompt for the lesson-extraction LLM call. The model receives one
 * task's feedback history and must produce general, reusable rules as JSON.
 */
export const LESSON_EXTRACTOR_PROMPT = `You are a lesson extractor for a TDD workflow. You receive the reviewer/quality-gate feedback a coding agent accumulated on ONE task. Distill it into at most 5 GENERAL, REUSABLE lessons that would prevent the same class of mistake in FUTURE, unrelated tasks.

Rules for lessons:
- Imperative, one sentence, max 200 characters (e.g. "Use a dedicated pg client for transactions — pool.query('BEGIN') runs each statement on a different connection").
- GENERAL: never mention task-specific identifiers (file names, work-item IDs, function names) unless they are project-wide conventions.
- Skip one-off issues that would not recur (typos, a single wrong constant).
- Include a "tags" array of lowercase keywords (library, language, gate, domain) used for matching lessons to future tasks.
- Optionally include "detail": one sentence with the concrete fix pattern.

Output ONLY a JSON array (no markdown fences, no prose):
[{"id": "kebab-case-slug", "rule": "...", "detail": "...", "tags": ["postgres", "testing"]}]

If the feedback contains nothing generalizable, output [].`;

/**
 * Parse the extractor LLM's response into candidates. Tolerates markdown
 * fences and surrounding prose; returns [] when no valid JSON array is found.
 */
export function parseLessonCandidates(text: string): LessonCandidate[] {
  if (!text) return [];
  // Strip fences, then find the first [...] block.
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c: any) => c && typeof c.rule === 'string' && c.rule.trim().length > 0)
      .map((c: any) => {
        const candidate: LessonCandidate = { rule: String(c.rule).slice(0, 300) };
        if (typeof c.id === 'string') candidate.id = c.id;
        if (typeof c.detail === 'string') candidate.detail = c.detail.slice(0, 300);
        if (Array.isArray(c.tags)) candidate.tags = c.tags.filter((t: any) => typeof t === 'string').slice(0, 8);
        return candidate;
      })
      .slice(0, 5);
  } catch {
    return [];
  }
}

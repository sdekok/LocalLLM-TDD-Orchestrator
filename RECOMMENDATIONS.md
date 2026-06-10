# Improvement Backlog (2026-06-09)

Self-contained task list distilled from a deep review-and-fix session. Each item has
enough context to execute cold — no prior conversation needed. Work top-down within
a priority band; items are independent unless noted.

> **Landed in the 2.1.0 batch (2026-06-09):** items **1, 2, 4, 6, 7** are done
> (commit pending). 742 tests green. One sub-part of item 1 was deliberately
> deferred — see **"Deferred from item 1"** below — and folded into the next round.

## Deferred from item 1 — collapse the per-phase branch safety nets

The attempt-ceiling persistence (the core of item 1) is done. The *other* half —
collapsing the duplicated "are we on the task branch?" checks (gates phase: search
`Running gates on`; reviewer phase: search `Reviewing on`) into ONE
ensure-task-branch step — was deferred. It's riskier than it looks: the
`checks out the task branch before reviewing` streaming test exercises those nets
indirectly (the mock `createBranch` doesn't update `getCurrentBranch`, so the
*net's* `safeCheckout` is what the test asserts). A clean collapse wants a
`sandbox.branchExists()` capability so the single top-of-attempt step can checkout
only when the branch exists, plus updating the sandbox mock. Do it as its own PR.

**Ground rules (from CLAUDE.md):** run `npm run build && npx vitest run` and fix all
failures before every commit/push. 718 tests currently green. After plugin changes,
`npm run deploylocal` rebuilds + symlinks into `~/.pi/extensions/tdd-workflow`
(a *running* Pi session keeps its loaded bundle — restart Pi to pick up changes).

**Environment context that motivates several items:** the user runs the agents
against a local vLLM server (Qwen 3.6 27B, 262K context window, gradual quality
degradation past ~140K tokens, `preserve_thinking` chat template, prefix caching
verified working at 98% hit when histories round-trip byte-identical). Model
profiles live in `models.config.json` (gitignored; global copy at
`~/.config/tdd-workflow/models.config.json`).

---

## P1 — Reliability

### 3. Real-model smoke test (`npm run smoke`)

**Why:** 718 unit tests, zero against a real model. A real crash (planner returning
JSON without a `subtasks` array → unguarded `.map`) shipped because mocks never
produce slightly-wrong-shaped output. Wiring breakage (model resolution, MCP
startup, chat-template/parser drift) is invisible to unit tests.

**Do:** a script (`scripts/smoke.ts` + `"smoke"` npm script) that:
1. Creates a throwaway git repo in a temp dir with a trivial package.json + vitest
   setup and one stub work item (e.g. "add an `add(a,b)` function with a test").
2. Runs `WorkflowExecutor.startNew` against the user's real `models.config.json`
   (requires the vLLM box up — this is a manual/opt-in script, not CI).
3. Asserts the task reaches `completed` and the branch merged; prints the per-task
   usage line. Time budget ~5-10 min.

**Accept:** `npm run smoke` passes against the live server; clear failure output
when the endpoint is down (the existing `ModelUnreachableError` path).

---

## P2 — Quality (unfinished from the context-management review)

### 5. Derive evidence caps from the model's context window

**Why:** The reviewer prompt says "the diff is your primary source of truth" but the
diff is truncated at **8,000 chars (~2.4K tokens)** — ~3% of a large branch diff —
while the routed model has a 262K window (~140K effective). Same for the fixer
(6KB), arbiter (6KB), and final-epic review (8KB). These caps predate the big-window
models and cost real review rounds (rejections for "missing" tests that sit past
the cutoff).

**Do:**
- Thread the reviewing/implementing model's `contextWindow` (via
  `modelRouter.selectModel(role)`) into the cap computations. Suggested:
  `diffCap = clamp(8_000, floor(contextWindow * charsPerToken * 0.15), 200_000)`
  chars, with the current values as floors for small models. `CHARS_PER_TOKEN`
  (3.3) is exported from `src/subagent/factory.ts`.
- Touch points: `buildTaskReviewPrompt` (`src/orchestrator/review-phase.ts`, the
  8000 literal), `buildFixerPrompt` diff cap (`MAX_DIFF_CHARS` in
  `src/orchestrator/executor.ts`), `buildArbiterPrompt`
  (`src/orchestrator/arbiter-phase.ts`, 6000 literal), `runFinalWorkflowReview` and
  `runStandaloneReview` (8000 literals in `executor.ts`),
  `boundFeedbackForPrompt` default (`src/orchestrator/feedback.ts`).
- Also cap the currently-UNBOUNDED Lens before/after sections in
  `buildTaskReviewPrompt` (they can dwarf the diff).
- Note: degradation past ~140K is gradual, and the user prefers *useful* context
  over hard limits — don't be stingy; 30-60K tokens of diff for the reviewer is the
  target on this hardware.

**Accept:** unit tests that a 262K-window profile yields ~40K+-char diff caps while
an 8K-window profile keeps today's values; Lens sections bounded.

---

## P3 — Simplification / hygiene

### 8. Root-directory hygiene

- `git rm test_planner.js` (root scratch script; imports from a since-rewritten
  module — likely broken anyway).
- Rename `pi-coding-agent.sln` → `CsharpAstAnalyzer.sln` and move next to
  `src/analysis/tools/CsharpAstAnalyzer/` (update `build:csharp` if it references
  the sln — it references the csproj, so likely no change).
- Create `docs/` and move `Integrate_GSD_Plan.md` (stale — predates the Pi-native
  architecture; mark as historical), `manual_tests.md`, `specs/` into it.
- Delete this file's completed items as they land.

### 9. Close the lessons feedback loop

The self-learning lesson store (`src/orchestrator/lessons.ts`, injected into
implementer first turns, `/tdd:lessons` to manage) and per-task usage/attempt
tracking (`src/orchestrator/usage-tracker.ts`) both exist, but nothing measures
whether lessons reduce iterations.

**Do:** at end-of-epic (in `processQueue` after the final-review block, where the
workflow usage summary is posted), compute avg attempts/task for the epic and
append a history entry to `.tdd-workflow/cache/epic-stats.json`
(`{ epicRef, completedAt, tasks, avgAttempts, totalTokens }`). Post a comparison
line in chat ("avg attempts/task: 2.1 — previous epic: 3.4"). Surface the last few
entries in `/tdd:status`.

**Accept:** stats file written per epic; chat line appears; covered by a unit test
on the stats computation.

### 10. Dogfood coverage thresholds in this repo

`vitest.config.ts` has no `coverage.thresholds` while the tool itself sells
blocking coverage gates. Current totals (June 9): ~79% lines / ~66% branches.
Add ratcheted thresholds slightly below current (e.g. lines 78, branches 64,
functions 79) so regressions fail CI; `.github/workflows/ci.yml` already runs
coverage.

# TDD Agentic Workflow Orchestrator (Pi Native)

A deeply integrated, agentic TDD workflow engine for the **Pi Coding Agent**. It replaces rigid JSON-based orchestration with native Pi sub-agent sessions, providing surgical file editing and self-correcting development loops using local or cloud LLMs.

## How It Works

```
Pi says "/tdd implement JWT auth"
         │
         ▼
   ┌─────────────┐
   │   Planner    │ ← Web search for best practices
   │  (sub-agent) │
   └──────┬──────┘
          │ Subtasks
          ▼
   ┌─────────────┐     ┌───────────────────┐
   │ Implementer  │ ──▶ │  Quality Gates     │
   │ (Sub-Agent)  │     │  lens (Type/AST)   │
   └──────┬──────┘     │  build → tests     │
          │             │  → lint            │
          │             │  + test metrics     │
          │             │  + coverage         │
          │             └──────┬────────────┘
          │ (Read/Edit)        │ Pass/Fail
          ▼                    ▼
   ┌─────────────┐     Algorithm decides:
   │  Reviewer    │     merge or retry
   │ (Sub-Agent)  │     (not the AI)
   └─────────────┘
```

The orchestrator spawns **ephemeral, headless sub-agent sessions** for planning, implementation, and review. These agents use Pi's native `read`, `write`, `edit`, and `bash` tools directly on your filesystem.

- **Self-Healing**: If quality gates fail, the executor rolls back changes and injects deterministic failure logs into the *next* attempt's system prompt.
- **Git Sandboxing**: Every subtask runs in an isolated git branch. Only proven, reviewed code is merged.
- **Deterministic Quality**: While the implementation is agentic, the gates (TSC, Vitest, etc.) are 100% deterministic.

## Quick Start

### 1. Prerequisites

- **Node.js 22.19+** (required by `@earendil-works/pi-coding-agent`)
- **llama.cpp** running (with [Pi-llama.cpp-provider](https://github.com/sdekok/Pi-llama.cpp-provider) recommended for automatic model settings)

### 2. Install & Register

```bash
npm install
npm run build

# Register the extension with Pi
pi install local:.
```

### 3. Configure Models

Run the interactive setup from inside any Pi session:

```
/setup
```

This discovers your available models from llama.cpp, lets you assign each to an agent role, and saves the config. Use `--global` to save as a system-wide default (`~/.config/tdd-workflow/models.config.json`) that applies to all projects.

### 4. Start a Workflow

Inside any project, use the slash commands:

- **Setup**: `/setup` — configure model routing interactively
- **Plan**: `/plan "Build a secure login system"` — decomposes into Epics/WorkItems. Defaults to **append mode**: existing epics in `WorkItems/` are preserved and used as context. Subcommands: `/plan list`, `/plan show <epic>`, `/plan revise [feedback]`. Flags: `--replace` (overwrite from epic-01), `--from-epic <id>` (extend a specific epic), `--brownfield` (force codebase exploration first).
- **Implement**: `/tdd 1` — loads Epic 1 from `WorkItems/` and executes
- **Resume from failure**: `/tdd 1 retry` — retry failed tasks from scratch; `/tdd 1 resume` — retry with reviewer feedback preserved; `/tdd 1 continue` — skip failed and continue
- **Pause/Stop/Resume** _(mid-workflow)_:
  - `/tdd:pause` — finish the current agent turn, then halt. WIP branch + feedback + attempts are preserved.
  - `/tdd:stop` — abort the running agent immediately, roll back the current task, reset it to pending. Repo looks like the task never ran.
  - `/tdd:resume` — pick up from a paused workflow.
- **Status**: `/tdd:status` — read-only snapshot of the current workflow: per-task progress, attempts, current phase, and the latest reviewer feedback.
- **Lessons**: `/tdd:lessons` — list the auto-learned lessons; `/tdd:lessons learn` — retroactively extract lessons from existing feedback logs; `/tdd:lessons forget <id>` — remove one.
- **Cleanup**: `/tdd:project-cleanup` — scan all quality gates, then run a TDD workflow to fix every pre-existing failure
- **Run tests**: `/tdd:test` — run the project's test suite and report failures
- **Research**: `/research "Best practices for React state 2026"` — deep web research agent
- **Analyze**: `/analyze` — architectural blueprinting

> **Tab completion**: every slash command above supports argument autocomplete inside Pi's editor. Press Tab after the command name to get suggestions — epic IDs for `/tdd <epic>` and `/plan show <epic>`, work item IDs after `task`, git branches after `/review branch`, research sessions after `/research --resume`, etc.

### 5. MCP Server Mode

The orchestrator can also run as a standalone MCP server:
```bash
node dist/interfaces/mcp/index.js
```

## Model Configuration

Model routing is driven by `models.config.json`. The system checks two locations and merges them, with the project config winning on any conflict:

| Location | Purpose |
|---|---|
| `~/.config/tdd-workflow/models.config.json` | System-wide defaults (all projects) |
| `<project>/models.config.json` | Project-specific overrides |

The easiest way to create or update either file is via `/setup` in Pi. You can also edit the JSON directly.

**Minimal config shape:**
```json
{
  "models": {
    "my-fast-model": {
      "name": "Qwen3 30B-A3B",
      "ggufFilename": "qwen3-30b-a3b-q4.gguf",
      "provider": "local",
      "contextWindow": 40960,
      "maxOutputTokens": 8192,
      "architecture": "moe",
      "speed": "fast",
      "enableThinking": false
    },
    "my-thinking-model": {
      "name": "Gemma 4 27B",
      "ggufFilename": "gemma-4-27b-q4.gguf",
      "provider": "local",
      "contextWindow": 128000,
      "maxOutputTokens": 8192,
      "architecture": "dense",
      "speed": "slow",
      "enableThinking": true
    }
  },
  "routing": {
    "plan":         "my-thinking-model",
    "project-plan": "my-thinking-model",
    "implement":    "my-fast-model",
    "review":       "my-thinking-model",
    "arbitrate":    "my-thinking-model",
    "research":     "my-fast-model"
  }
}
```

**Routing keys** are all optional except the ones you actually use. Any role that isn't explicitly routed falls back to the `plan` model. `/setup` configures `plan`, `project-plan`, `implement`, `review`, and `research` — you can add `arbitrate` manually if you want the deadlock-breaking arbiter on a different model than the planner.

**`sessionRefreshTokens`** _(optional)_ controls when the implementer's long-running session is replaced with a fresh one: once the session's *actual* prompt size (input + cache-read tokens, as reported by the provider) crosses this threshold. Defaults to `contextWindow / 2`. Set it to the point where your model's long-context quality starts to degrade — often well below the advertised window. The legacy `sessionRefreshAfter` round cadence now applies only when the provider reports no token usage. Old thinking blocks are also the first thing the in-session context pruner reclaims, since stale reasoning has near-zero forward value for preserved-thinking models.

**`enableThinking`** tells the orchestrator to activate Pi's reasoning mode (`setThinkingLevel('medium')`) and strip thinking blocks from multi-turn message history to keep quality high. Reasoning-token injection is handled at the llama.cpp / chat-template level — no plugin-side prompt mutations are needed.

**Cloud providers** are also supported. API keys must be supplied via environment variables — never hardcoded:

```json
{
  "modelId": "anthropic/claude-sonnet-4",
  "provider": "openrouter",
  "apiKeyEnvVar": "OPENROUTER_API_KEY"
}
```

> `models.config.json` and `models.config.local.json` are listed in `.gitignore` to prevent accidental secret commits.

## Implementer → Reviewer Handoff

The implementer and reviewer are separate agents that communicate through structured artifacts, not shared memory:

1. **Implementation notes** — at the end of its session the implementer writes `.tdd-workflow/implementation-notes.md` explaining design decisions, trade-offs, and any pre-existing issues it left alone intentionally.
2. **Git diff** — after the implementer finishes, the executor captures the full work-item branch diff against its base (`git diff <base>...HEAD`, plus any uncommitted changes), and injects it — with a changed-file list and the per-commit log — directly into the reviewer's prompt. On resume the executor first checks out the work-item branch, so the reviewer always inspects the committed work rather than the base branch.
3. **Scoped review** — the reviewer is instructed to treat the diff as its primary source of truth and only read additional files when the diff alone is insufficient to evaluate a type or test path.
4. **Concise fix checklist** — when the reviewer rejects, the full feedback is written to `.tdd-workflow/logs/feedback-history-<task>.md` and the implementer is sent a short numbered checklist of just the action items (extracted from the reviewer's numbered issues, excluding any "non-issues" the reviewer noted). This keeps each retry prompt small and focused while the full detail stays on disk for the agent to read when needed.

This means the reviewer always knows exactly what changed and why — it doesn't need to discover changes by exploring the filesystem.

## Safety & Runaway Protection

| Guard | What It Catches | Behavior |
|---|---|---|
| **Max attempts** (5/task) | Persistent failures | Triggers the neutral arbiter before giving up |
| **Arbiter** (after attempt 5) | Implementer/reviewer deadlock | Approves, grants up to 3 extra rounds, or escalates to you |
| **Output similarity** (>90%) | Agent stuck in a loop | Bails immediately, before wasting the reviewer's time |
| **Implementer timeout** (60 min) | Hung implementer session | Throws into the catch block; next attempt starts fresh |
| **Reviewer timeout** (60 min) | Hung reviewer session | Same — independent of the implementer budget |
| **Arbiter timeout** (20 min) | Hung arbiter session | Defaults to escalate |
| **Circuit breaker** (3 consecutive failures) | Systemic problems | Stops entire workflow |

Timeouts are enforced independently per agent via `Promise.race`. When a task exhausts all attempts, the **neutral arbiter** reviews the final diff, quality gate status, and reviewer feedback, then decides:
- **Approve** — QA passed and the reviewer was being too strict; merges as-is
- **Continue N** — grants 1–3 extra implementation rounds
- **Escalate** — posts the situation to Pi chat and waits for you to reply with `approve`, `continue 1–3`, or `stop`

When a task ultimately fails, the workflow stops and posts a chat message with the branch name, state file location, and exact resume command. The failed branch is preserved for inspection — nothing is cleaned up automatically.

## Self-Learning Lessons

The orchestrator learns from its own review cycles. After any task that needed feedback rounds, an extraction step (using the `arbitrate` model) distills the reviewer/gate feedback into short, general, imperative rules — e.g. *"Wrap multi-statement Postgres transactions on one dedicated client"*. Lessons live in `.tdd-workflow/lessons.json` (project) merged with `~/.config/tdd-workflow/lessons.json` (global, project wins).

- **Injection**: lessons observed in **2+ distinct tasks** (or marked `"confirmed": true`) are scored against the task description by tag match, occurrences, and recency; the top 10 are added to the implementer's first-turn prompt. One-off observations are stored but not injected — a single reviewer nit shouldn't become policy.
- **Reinforcement**: re-occurrence in a *new* task bumps the lesson's count; the same task reporting it twice does not. Re-running extraction is idempotent.
- **Retroactive learning**: `/tdd:lessons learn [N]` scans the newest N (default 30) `feedback-history-*.md` files in `.tdd-workflow/logs/` and merges what it finds.
- **Curation**: `/tdd:lessons` lists everything (🟢 = currently injected); `/tdd:lessons forget <id>` removes a bad rule. Hand-edit the JSON to set `"confirmed": true` on rules that should always apply.
- The store is capped at 100 lessons; the weakest (fewest occurrences, oldest) are pruned first and confirmed lessons always survive.

The payoff metric is attempts-per-task: as the store converges on your models' habitual failure modes, first-attempt approvals should rise — the per-task usage summaries give you the before/after numbers.

## Pre-existing Failures (Baseline)

Before any agent runs, the orchestrator captures a **baseline** of every blocking gate so that issues which were already broken don't get blamed on — or block — the implementer. Only failures the implementer *introduces* are treated as regressions; pre-existing ones are reported once and then ignored.

The baseline runs at **full workspace scope**. In an Nx monorepo the per-task gates use `nx affected` (fast — only the projects touched by the diff), but the baseline uses `nx run-many` (every project). This matters because `nx affected` against the initial empty diff would build/lint *nothing* and record no pre-existing debt — then the first task to touch a project would make that whole project "affected" and surface its pre-existing lint warnings as if the task had introduced them. Capturing the baseline across the whole workspace records the real prior state, so per-task `affected` failures are correctly recognised as pre-existing and masked.

## Pausing and Stopping a Workflow

The orchestrator runs in the background once `/tdd` is invoked, but you can interrupt it from chat at any time:

| Action | What it does | Current task ends up as | Branch | Feedback / attempts |
|---|---|---|---|---|
| `/tdd:pause` | Finishes the current agent turn, then halts the workflow. | `paused` | preserved | preserved |
| `/tdd:stop` | Aborts the running agent immediately, rolls back the task branch to base. | `pending` (reset) | rolled back | cleared |
| `/tdd:resume` | Resumes a paused workflow — picks up the paused task with its WIP branch + feedback intact. | `pending` → runs to completion | reused | preserved |

**When to use which:**

- **Pause** when you need to step away, reboot, or context-switch, and want to continue later right where the agent was. The task's progress and reviewer feedback are kept.
- **Stop** when you realise the current task is going nowhere and you want a clean slate — e.g. the planner mis-scoped the work, or you want to hand-edit and re-plan. Other tasks in the epic are untouched.

`/tdd:resume` picks up any `paused` tasks automatically. You can also use the existing `/tdd N resume` / `/tdd N retry` / `/tdd N continue` subcommands — they work alongside pause/stop.

## Project Cleanup

`/tdd:project-cleanup` runs quality gates before any agent starts, summarises every failing gate in chat, then hands a structured cleanup brief to the standard TDD executor. The on-the-fly planner decomposes "fix these specific failures" into per-gate subtasks, each of which goes through the normal implement → review → merge loop.

- The implementer is instructed to only fix failures in files it is already modifying, so cleanup stays scoped and doesn't cause unrelated drift.
- A coverage snapshot is always collected during cleanup (even without `coverageThresholds`) so the planner can see where coverage is low and add test-improvement subtasks if meaningful. Coverage numbers never block the cleanup workflow unless thresholds are explicitly configured.
- Full gate output (potentially large) is written to `.tdd-workflow/logs/gate-report-<timestamp>.log`. The cleanup brief embeds a truncated summary pointing to this file; implementer agents can read the full log when they need more context.
- Subtasks whose descriptions mention "coverage" or "add tests" automatically tell the implementer to verify using the coverage command and include before/after numbers in the `DONE:` message.

## Planning Workflow (`/plan`)

`/plan` decomposes a request into Epics and WorkItems. It runs in two phases inside a fresh sub-agent session: Phase 1 produces the epic overview, Phase 2 fills in work items for each epic (one ephemeral session per epic).

**Append vs replace (mode):**

| | Append (default) | Replace (`--replace`) |
|---|---|---|
| Existing epics in `WorkItems/` | Preserved; surfaced to the planner as context with instructions not to redefine them | Ignored by the planner |
| New epic numbering | Starts at `maxIndex + 1` (no clobbering) | Starts at `01` (clobbers prior epics with the same index) |
| Matching slug | Updates the existing `epic-NN-slug.md` in place | Writes a fresh `epic-01-slug.md` regardless of prior state |
| `_overview.md` | Prior summary + decisions are merged with the new ones, dedup'd | Overwritten from scratch |

Use **append** when extending a plan with new scope; use **`--replace`** only when you genuinely want to throw away the existing plan.

**Subcommands:**

- `/plan list` — Print existing epics with their work-item counts.
- `/plan show <epic>` — Post the full markdown of one epic to chat. Accepts an epic ID, slug, or filename.
- `/plan revise [feedback]` — Re-run planning in append mode, picking up the previous request from `.tdd-workflow/planning/_request.json` and incorporating your feedback. You no longer need to retype the original request when you want changes. If you don't pass feedback inline, the command prompts for it.

**Flags (combine freely with subcommands):**

- `--from-epic <id>` — Inline the markdown of an existing epic as planner context so the new plan extends that specific epic.
- `--brownfield` — Force the planner to explore the codebase before proposing epics. Useful when adding to a mature project.
- `--replace` — Opt out of append mode (see table above).

**Iterative feedback loop:**

When you give feedback at the plan-review prompt, it's now saved to `.tdd-workflow/planning/_pending_feedback.txt`. Run `/plan revise` and the planner will pick up where it left off — original request plus your revision request, in append mode — instead of starting from scratch.

## Multi-Language Support

The orchestrator includes a native code analyzer that supports:
- **TypeScript/JavaScript**: Full AST analysis via `ts-morph`.
- **C#**: Analysis via a Roslyn sidecar (requires .NET 10 SDK).
- **C++**: AST analysis via `tree-sitter`.

## Commit Messages

Each per-attempt implementer commit includes quality gate results and test/coverage metrics:

```
TDD [Attempt 1]: Create JWT token generation

---
Attempt: 1

Quality Gates:
  ✅ build (blocking)
  ✅ tests (blocking)
  ✅ coverage (blocking)
  ✅ lint (blocking)

Tests: 47/47 passed
Coverage: 87.3% lines, 72.1% branches, 91.0% functions
LLM Usage: 36,520 in / 8,522 out tokens · 3 calls (implementer 2, reviewer 1) · 12m03s
```

## Development

```bash
npm run test          # Run unit tests (vitest)
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage
npm run build         # Compile TypeScript + bundle
npm run build:csharp  # Build the Roslyn C# analyzer (requires .NET 10 SDK)
npm run build:all     # Full build (csharp + typescript)
npm run deploylocal   # Symlink into ~/.pi/extensions for live development
```

## Project Config (`tddConfig` in `package.json`)

Optional settings can be placed in the `tddConfig` key of the project's `package.json`:

```json
"tddConfig": {
  "coverageThresholds": {
    "lines": 80,
    "functions": 80,
    "branches": 70
  },
  "fileSafetyAllowlist": ["fixtures/", "custom-dir/"]
}
```

| Key | Default | Description |
|---|---|---|
| `coverageThresholds` | _(unset)_ | **Opt-in.** When present, the coverage gate becomes blocking and enforces these minimums. Omit this key entirely to disable the blocking coverage gate (coverage metrics are still collected for reporting). Supported thresholds: `lines`, `functions`, `branches`, `statements`. |
| `fileSafetyAllowlist` | `[]` | Extra path prefixes the file-safety gate should not flag. See built-in prefixes below. |

**Built-in file-safety prefixes** (always allowed — no config needed):
`src/`, `tests/`, `test/`, `__tests__/`, `e2e/`, `lib/`, `libs/`, `apps/`, `packages/`, `docs/`, `scripts/`, `config/`, `public/`, `static/`, `assets/`, `styles/`, `schemas/`, `migrations/`, `prisma/`, `coverage/`, `.github/`, `.vscode/`, `.pi-lens/`, `.tdd-workflow/`

**Built-in file-safety patterns** (matched at repo root):
- Package manifests / lockfiles (`package.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `pnpm-workspace.yaml`)
- TS / lint / formatter configs (`tsconfig*.json`, `.eslintrc*`, `eslint.config.*`, `vitest.config.*`, `jest.config.*`, `prettier.config.*`, `.prettierrc*`)
- Root dotfiles (`.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`, `.dockerignore`, `.env.example`, etc.)
- Framework / monorepo / bundler configs (`turbo.json`, `nx.json`, `project.json`, `vite.config.*`, `next.config.*`, `tailwind.config.*`, etc.)
- Docker (`Dockerfile*`, `docker-compose*.yml`, `.docker/`)
- Root docs (`README*`, `CHANGELOG*`, `LICENSE*`, `CONTRIBUTING*`, and any `*.md`/`*.mdx` at the root)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LLAMA_CPP_URL` | `http://localhost:8080/v1` | llama.cpp server URL |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG search URL |
| `OPENROUTER_API_KEY` | — | API key for OpenRouter models |
| `OPENAI_API_KEY` | — | API key for OpenAI models |
| `TDD_WORKFLOW_CONFIG_DIR` | — | Override config file search directory |
| `LENS_FAIL_POLICY` | `fail-closed` | `fail-open` skips the Lens gate on crash; `fail-closed` treats a crash as a failure |
| `TDD_SLOT_RECOVERY_MS` | `500` | Milliseconds to wait after sub-agent disposal before starting the next agent. Since Pi SDK 0.78 `dispose()` hard-aborts the in-flight request, so this is a safety margin; raise it for servers that linger on aborted requests |
| `TDD_MCP_STARTUP_MS` | `5000` | Milliseconds to wait for MCP servers (context-mode, searxng) to register tools after session creation |

## Pi Version Notes

Requires `@earendil-works/pi-coding-agent` ≥ 0.79:

- **Project trust** (Pi 0.79+): sub-agent sessions explicitly trust the project they run in (the orchestrator only ever runs where you point it). For the *host* Pi session, accept the trust prompt on first run in a repo — or set `defaultProjectTrust` in `~/.pi/agent/settings.json` — otherwise project-local extensions (context-mode, pi-lens) won't load.
- **Provider retries**: transient provider failures (e.g. an inference-server restart mid-workflow) are retried by the SDK before the orchestrator's model-unreachable fast-fail kicks in. Tune with `retry.provider.maxRetries` in `~/.pi/agent/settings.json`.
- **Cache-hit visibility**: Pi's interactive footer shows the latest prompt-cache hit rate (`CH`) — useful for confirming preserved-thinking prefix caching is working during TDD runs.

## Diagnostics

Every sub-agent session emits per-LLM-call telemetry to the standard plugin log:

```
[SUBAGENT TELEMETRY implement] status=200 latency=1843ms rate-remaining=99
[SUBAGENT TELEMETRY review]    status=429 latency=420ms  rate-remaining=0
```

`status` and HTTP latency come from the SDK's `after_provider_response` hook; any non-2xx response is logged as a warning so rate limits and provider errors surface without needing a dashboard. The `taskType` tag distinguishes implementer / reviewer / planner / arbiter / research calls when grepping the log.

**Token/time accounting**: every task accumulates per-role token usage (input/output/cached) and wall time. The summary is appended to each attempt's commit message (`LLM Usage:` trailer), posted to chat when a task completes or fails (`📊 WI-x usage: …`), and a workflow-wide total is posted when the epic finishes. Use it to spot which tasks burn the most budget and tune model routing accordingly.

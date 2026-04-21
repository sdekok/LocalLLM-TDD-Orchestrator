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
   └──────┬──────┘     │  tsc → tests       │
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

- **Node.js 20+**
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
- **Plan**: `/plan "Build a secure login system"` — decomposes into Epics/WorkItems
- **Implement**: `/tdd 1` — loads Epic 1 from `WorkItems/` and executes
- **Resume from failure**: `/tdd 1 retry` — retry failed tasks from scratch; `/tdd 1 resume` — retry with reviewer feedback preserved; `/tdd 1 continue` — skip failed and continue
- **Pause/Stop/Resume** _(mid-workflow)_:
  - `/tdd:pause` — finish the current agent turn, then halt. WIP branch + feedback + attempts are preserved.
  - `/tdd:stop` — abort the running agent immediately, roll back the current task, reset it to pending. Repo looks like the task never ran.
  - `/tdd:resume` — pick up from a paused workflow.
- **Cleanup**: `/tdd:project-cleanup` — scan all quality gates, then run a TDD workflow to fix every pre-existing failure
- **Run tests**: `/tdd:test` — run the project's test suite and report failures
- **Research**: `/research "Best practices for React state 2026"` — deep web research agent
- **Analyze**: `/analyze` — architectural blueprinting

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
2. **Git diff** — the executor captures `git diff HEAD` after the implementer finishes and injects it (plus a changed-file list) directly into the reviewer's prompt.
3. **Scoped review** — the reviewer is instructed to treat the diff as its primary source of truth and only read additional files when the diff alone is insufficient to evaluate a type or test path.

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

The implementer is instructed to only fix failures in files it is already modifying, so cleanup stays scoped and doesn't cause unrelated drift.

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
  ✅ typescript (blocking)
  ✅ tests (blocking)
  ✅ coverage (blocking)
  ⚠️ lint

Tests: 47/47 passed
Coverage: 87.3% lines, 72.1% branches, 91.0% functions
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
| `coverageThresholds` | _(unset)_ | **Opt-in.** When present, the coverage gate becomes blocking and enforces these minimums. Omit this key entirely to skip the coverage gate (useful for projects without tests yet). Supported thresholds: `lines`, `functions`, `branches`, `statements`. |
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
| `TDD_SLOT_RECOVERY_MS` | `5000` | Milliseconds to wait after sub-agent disposal before reusing the slot |
| `TDD_MCP_STARTUP_MS` | `5000` | Milliseconds to wait for MCP servers (context-mode, searxng) to register tools after session creation |

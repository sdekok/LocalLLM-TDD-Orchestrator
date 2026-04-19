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
- **Resume**: `/tdd 1 retry` — retry failed tasks and continue; `/tdd 1 continue` — skip failed and continue
- **Cleanup**: `/tdd:project-cleanup` — scan all quality gates, then run a TDD workflow to fix every pre-existing failure
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
    "research":     "my-fast-model"
  }
}
```

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
| **Max attempts** (5/task) | Persistent failures | Marks task failed, stops workflow — awaits `/tdd <n> retry\|continue` |
| **Output similarity** (>90%) | Agent stuck in a loop | Bails immediately, before wasting the reviewer's time |
| **Implementer timeout** (60 min) | Hung implementer session | Throws into the catch block; next attempt starts fresh |
| **Reviewer timeout** (60 min) | Hung reviewer session | Same — independent of the implementer budget |
| **Circuit breaker** (3 consecutive failures) | Systemic problems | Stops entire workflow |

Timeouts are enforced independently per agent via `Promise.race` — a slow implementer cannot eat the reviewer's budget. When a task fails, the workflow stops and posts a chat message with the branch name, state file location, and exact resume command. The failed branch is preserved for inspection — nothing is cleaned up automatically.

## Project Cleanup

`/tdd:project-cleanup` runs quality gates before any agent starts, summarises every failing gate in chat, then hands a structured cleanup brief to the standard TDD executor. The on-the-fly planner decomposes "fix these specific failures" into per-gate subtasks, each of which goes through the normal implement → review → merge loop.

The implementer is instructed to only fix failures in files it is already modifying, so cleanup stays scoped and doesn't cause unrelated drift.

## Multi-Language Support

The orchestrator includes a native code analyzer that supports:
- **TypeScript/JavaScript**: Full AST analysis via `ts-morph`.
- **C#**: Analysis via a Roslyn sidecar (requires .NET 10 SDK).
- **C++**: AST analysis via `tree-sitter`.

## Commit Messages

Every merge commit includes quality gate results, test counts, and reviewer feedback:

```
TDD: Create JWT token generation

---
Quality Gates: ✅ lens, ✅ typescript, ✅ tests, ⚠️ lint
Tests: 47/47 passed
Coverage: 87.3% lines, 72.1% branches, 91.0% functions
Reviewer Score: 17/20
Reviewer: Good test coverage, clean error handling.
Files: src/auth/jwt.ts, tests/auth/jwt.test.ts
```

## Development

```bash
npm run test         # Run unit tests (vitest)
npm run build        # Compile TypeScript
npm run build:csharp # Build the Roslyn C# analyzer (requires .NET 10 SDK)
npm run build:all    # Full build
npm run dev          # Watch mode
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
  "fileSafetyAllowlist": ["scripts/", "config/", "fixtures/", "e2e/"]
}
```

| Key | Default | Description |
|---|---|---|
| `coverageThresholds.lines` | `80` | Minimum line coverage % |
| `coverageThresholds.functions` | `80` | Minimum function coverage % |
| `coverageThresholds.branches` | `70` | Minimum branch coverage % |
| `fileSafetyAllowlist` | `[]` | Extra path prefixes (e.g. `"scripts/"`) the file-safety gate should not flag. Built-in safe prefixes include `src/`, `tests/`, `libs/`, `apps/`, `packages/`, `docs/`, `coverage/`, `.pi-lens/`, `.tdd-workflow/`, and common root files (`.gitignore`, lock files, `tsconfig*.json`). |

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

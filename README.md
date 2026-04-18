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

## Safety & Runaway Protection

| Guard | What It Catches | Behavior |
|---|---|---|
| **Max attempts** (3/task) | Persistent failures | Marks task failed, stops workflow — awaits `/tdd <n> retry\|continue` |
| **Output similarity** (>90%) | Agent stuck in a loop | Bails immediately |
| **Time budget** (10 min/task) | LLM hangs, runaway tool calls | Breaks the attempt loop |
| **Circuit breaker** (3 failures) | Systemic problems | Stops entire workflow |

When a task fails the workflow stops and posts a chat message explaining what to do next. The failed branch is preserved for inspection — nothing is cleaned up automatically.

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

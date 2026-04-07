# TDD Agentic Workflow Orchestrator (Pi Native)

A deeply integrated, agentic TDD workflow engine for the **Pi Coding Agent**. It replaces rigid JSON-based orchestration with native Pi sub-agent sessions, providing surgical file editing and self-correcting development loops using local or cloud LLMs.

### NEW: World-Class Project Planning & MCP
- **World-Class Planning**: The orchestrator now features a `/plan` command for deep project decomposition. This generates rich, multi-dimensional `WorkItems/*.md` files including **Acceptance Criteria**, **Security Strategies**, and **Specific Test Cases**. Subsequent `/tdd` runs automatically parse and inject this metadata into the implementation sub-agent.
- **MCP Server Support**: The orchestrator now acts as a standalone **Model Context Protocol (MCP)** server, allowing integration with any MCP IDE.
- **Tool Discovery**: Sub-agents now automatically inherit and use your installed Pi extensions (like `context-mode`) via the `pi-mcp-adapter`.

## How It Works (Agentic Mode)

```
Pi says "/tdd implement JWT auth"
         │
         ▼
   ┌─────────────┐
   │   Planner    │ ← Web search for best practices
   │  (dense LLM) │
   └──────┬──────┘
          │ Subtasks
          ▼
   ┌─────────────┐     ┌───────────────────┐
   │ Implementer  │ ──▶ │  Quality Gates     │
   │ (Sub-Agent)  │     │  tsc → tests       │
   └──────┬──────┘     │  → lint            │
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

The orchestrator spawns **ephemeral, headless sub-agent sessions** for implementation and review. These agents use Pi's native `read`, `write`, `edit`, and `bash` tools directly on your filesystem. 

- **Self-Healing**: If quality gates fail, the executor rolls back changes and injects deterministic failure logs into the *next* attempt's system prompt.
- **Git Sandboxing**: Every subtask runs in an isolated git branch. Only proven, reviewed code is merged.
- **MCP Tool Discovery**: Sub-agents use the `pi-mcp-adapter` to access external tools, making them capable of using the latest context-gathering libraries.
- **Deterministic Quality**: While the implementation is agentic, the gates (TSC, Vitest, etc.) are 100% deterministic.

## Quick Start

### 1. Prerequisites

- **Node.js 20+**
- **llama.cpp** running in Router Mode:
  ```bash
  ./llama-server --models-dir /path/to/your/models --host 0.0.0.0 --port 8080
  ```

### 2. Install & Register

```bash
cd pi-coding-agent
npm install
npm run build

# Register the extension with Pi
pi install local:.
```

### 3. Start a Workflow

Inside any project, simply use the slash commands:

- **Plan**: `/plan "Build a secure login system"` (Decomposes into Epics/WorkItems with rich metadata)
- **Implement**: `/tdd 1` (Loads from `WorkItems/`, parses all metadata, and executes)
- **Research**: `/research "Best practices for React state 2026"` (Deep web + video research agent)
- **Status**: `/status` (Check progress of the current workflow)
- **Analyze**: `/analyze` (Deep architectural blueprinting)

### 4. MCP Server Mode

The orchestrator can also run as a standalone MCP server:
```bash
node dist/interfaces/mcp/index.js
```
This exposes the core workflows (start, resume, status, analyze) to your MCP client.

## Safety & Runaway Protection

| Guard | What It Catches | Behavior |
|---|---|---|
| **Max attempts** (3/task) | Persistent failures | Marks task as failed, moves to next |
| **Output similarity** (>90%) | Agent stuck in a loop | Bails immediately — doesn't waste remaining attempts |
| **Time budget** (15 min/task) | LLM hangs, runaway tool calls | Breaks the attempt loop, marks task as failed |
| **Circuit breaker** (3 failures) | Systemic problems | Stops entire workflow with clear message |

## Multi-Language Support

The orchestrator includes a native code analyzer that supports:
- **TypeScript/JavaScript**: Full AST analysis via `ts-morph`.
- **C#**: Analysis via a Roslyn sidecar (requires .NET 10 SDK).
- **C++**: AST analysis via `tree-sitter`.

Run an analysis without starting a workflow:
```
/analyze
```

## Model Configuration

Configure your models in `models.config.json`. The system supports:
- **Local**: llama.cpp (OpenAI-compatible)
- **Cloud**: OpenRouter, OpenAI, Anthropic
- **Optimized Tuning**: Built-in tuners for **Gemma 4** (thinking prompts) and **Qwen 3.5** (sampling floors).

## Commit Messages

Every merge commit includes quality gate results, test counts, and reviewer feedback:

```
TDD: Create JWT token generation

---
Quality Gates: ✅ typescript, ✅ tests, ⚠️ lint
Tests: 47/47 passed
Coverage: 87.3% lines, 72.1% branches, 91.0% functions
Reviewer Score: 17/20
Reviewer: Good test coverage, clean error handling.
Files: src/auth/jwt.ts, tests/auth/jwt.test.ts
```

## Development

```bash
npm run test         # Run unit tests (vitest)
npm run build        # Compile extension
npm run dev          # Watch mode
```riable | Default | Description |
|---|---|---|
| `LLAMA_CPP_URL` | `http://localhost:8080/v1` | llama.cpp server URL |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG search URL |
| `OPENROUTER_API_KEY` | — | API key for OpenRouter models |
| `OPENAI_API_KEY` | — | API key for OpenAI models |
| `TDD_WORKFLOW_CONFIG_DIR` | — | Override config file search directory |

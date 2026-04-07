# TDD Agentic Workflow Orchestrator (Pi Native)

A deeply integrated, agentic TDD workflow engine for the **Pi Coding Agent**. It replaces rigid JSON-based orchestration with native Pi sub-agent sessions, providing surgical file editing and self-correcting development loops using local or cloud LLMs.

### NEW: MCP & Project-Level Planning
- **MCP Server Support**: The orchestrator now exposes its core workflows as **Model Context Protocol (MCP)** tools, allowing integration with any MCP-capable IDE or client.
- **Project Planning**: A dedicated `/plan` command decomposes large features into a `WorkItems/` directory, enabling a structured "Plan → Review → Execute" cycle.
- **Tool Inheritance**: Sub-agents now automatically inherit all installed Pi extensions and MCP tools (like `context-mode`), allowing them to use high-level contextual discovery tools.

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

- **Plan**: `/plan Build a secure login system` (Decomposes into Epics/WorkItems)
- **Implement**: `/tdd Implement Epic 1` (Loads from `WorkItems/` and executes)
- **Direct**: `/tdd Add a secure login endpoint` (On-the-fly planning with sub-refinement)
- **Status**: `/status` (Check progress of the current workflow)

### 4. MCP Server Mode

You can also run the orchestrator as a standalone MCP server:
```bash
node dist/interfaces/mcp/index.js
```
This exposes the following tools to your MCP client:
- `start_tdd_workflow`: Start a background implementation loop.
- `resume_tdd_workflow`: Resume from a pause or failure.
- `check_workflow_status`: Get structured JSON status of all tasks.
- `analyze_project`: Run the deep architectural analyzer.

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

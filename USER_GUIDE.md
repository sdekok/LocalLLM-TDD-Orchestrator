# User Guide — TDD Agentic Workflow (Pi Native)

## Overview

The TDD Agentic Workflow orchestrator is a native **Pi Extension** that automates feature implementation through ephemeral sub-agent sessions. You describe what you want, and the system:

1. **Analysis** — Automatically runs `/analyze` to build a fresh blueprint of your codebase (exports, types, patterns).
2. **Planning** — Decomposes your request into high-level Epics and WorkItems, creating a `WorkItems/` directory.
3. **Execution (`/tdd`)** — Swims through the workitems, implementing each one via an ephemeral sub-agent.
4. **Sub-Refinement** — If a workitem is too broad, the orchestrator sub-refines it into granular TDD technical steps before implementation.
5. **Validation & Review** — Deterministic quality gates (TSC, Tests) followed by an LLM-powered review.
6. **MCP Discovery** — Sub-agents now automatically inherit and use your installed MCP tools (e.g., `context-mode`) for enhanced discovery.

## Installation

### 1. Build the Project
```bash
cd /path/to/pi-coding-agent
npm install
npm run build
```

### 2. Register with Pi
Run the following command in your terminal to register the extension:
```bash
pi install local:.
```

## Using Slash Commands

Once installed, you can trigger the workflow directly from any Pi session using slash commands.

### `/tdd <request>`
Starts a full TDD workflow in the current directory.
- **Example**: `/tdd Add a secure JWT authentication middleware with refresh tokens`
- **What happens**: The Planner starts, subtasks are created, and Pi begins the implementation loop in the background.

### `/plan <request>`
Decomposes a large project or feature into structured Epics and WorkItems.
- **Output**: Creates a `WorkItems/` directory at the project root with markdown files.
- **Workflow**: Plan first, review the generated files, then use `/tdd` to implement.
- **Analysis Integration**: Automatically runs `/analyze` first to ensure the architect has a fresh blueprint of the codebase.

### `/analyze`
Performs a deep architectural analysis of the current repository.
- **Supported Languages**: TypeScript, JavaScript, C#, C++.
- **Benefit**: Caches a "blueprint" of the repository that the Planner and Architect use to generate more accurate tasks.

## Model Configuration

The orchestrator uses a `models.config.json` file to route different tasks to appropriate models.

- **Local (llama.cpp)**: Default provider. Supports "Router Mode" for on-demand model loading.
- **Cloud**: Supports OpenRouter, OpenAI, and Anthropic providers.

### Optimized Tunings
The system includes built-in "Tuners" that automatically adjust sampling and prompts for specific models:
- **Gemma 4**: Injects `<|think|>` triggers into system prompts when thinking is enabled.
- **Qwen 3.5**: Floors temperature to `0.6` for thinking models to prevent degradation.

## Project Planning: Plan-Review-Execute

For complex features, we recommend the following lifecycle:

1.  **Plan**: Run `/plan "Feature description"` to generate epics.
2.  **Review**: Open the generated `WorkItems/epic-XX.md` files. Edit them if the plan isn't quite right.
3.  **Refine**: Update `agents.md` if the architect identified new cross-cutting constraints.
4.  **Execute**: Run `/tdd Implement Epic 01`. The system will load the work items and sub-refine them into technical TDD steps.
5.  **Monitor**: Use `/status` or the MCP `check_workflow_status` tool to see exactly where the agent is in the process.

## Under the Hood: Agentic Sessions

Unlike legacy MCP servers, this orchestrator uses **ephemeral agent sessions** (`createAgentSession`). 

- **Statefulness**: Within a single "attempt", the Implementer agent can freely read files, run tests, and fix its own errors multiple times before submitting for validation.
- **Tool Access**: Agents have access to the same native tools as you: `read`, `write`, `edit`, and `bash`.
- **MCP Tool Inheritance**: Sub-agents inherit tools from the parent Pi session (via `pi-mcp-adapter`). If you have `context-mode` or `search` installed, the implementer can use them.
- **Feedback Loop**: If a Reviewer rejects a PR or a Quality Gate fails, the Orchestrator algorithmically templates the failure logs into the *next* session's system prompt.

## Quality Gates & Coverage

The orchestrator does **not** ask an AI if the code is good enough. Instead, it runs deterministic checks:

| Gate | Type | What It Checks |
|---|---|---|
| **TypeScript** | Blocking | `npx tsc --noEmit` — any type errors fail the gate |
| **Tests** | Blocking | Auto-detects test framework (vitest, jest, mocha, ava, node:test) and runs the suite |
| **Lint** | Non-blocking | ESLint warnings are logged but don't block |
| **File Safety** | Blocking | Ensures files were only written to expected directories (src/, tests/) |

### Code Coverage Detection
If you have a coverage tool installed, coverage is **automatically** detected and included in the merge commit message:
- **Vitest**: Install `@vitest/coverage-v8` for automatic support.
- **Jest**: Built-in `--coverage` flag is utilized.
- **Custom**: If you have a `test:coverage` or `coverage` script in `package.json`, it's used instead.

## Safety & Controls

- **Git Sandboxing**: Every subtask is isolated in its own branch. No code is merged unless it passes all deterministic gates.
- **Circuit Breaker**: If 3 consecutive subtasks fail completely (exhausted retries), the entire workflow stops to prevent wasting tokens/compute.
- **Loop Detection**: If an agent produces nearly identical changes (>90% similarity) across attempts, the system bails early and flags the task for manual intervention.

## Troubleshooting

| Issue | Solution |
|---|---|
| Command not found | Ensure you ran `npm run build` and `pi install local:.` correctly. |
| Model "X" not found | Check `models.config.json` and ensure your llama.cpp server is running in "Router Mode". |
| Workflow hangs | Check `.tdd-workflow/logs/` for details. Usually means the LLM is stuck or local VRAM is exhausted. |
| Quality gates always fail | Verify your `package.json` scripts (`test`, `build`) work manually first. |

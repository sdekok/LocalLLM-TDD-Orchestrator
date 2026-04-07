# User Guide — TDD Agentic Workflow (Pi Native)

## Overview

The TDD Agentic Workflow orchestrator is a native **Pi Extension** that automates feature implementation through ephemeral sub-agent sessions. You describe what you want, and the system:

1. **Plans** — Breaks your request into testable subtasks, researching best practices via web search.
2. **Implements** — Spawns a headless Pi sub-agent that writes tests and code natively using `read`, `edit`, and `bash` tools.
3. **Validates** — Runs deterministic quality gates (TypeScript compilation, test suite, linting) on the sub-agent's work.
4. **Reviews** — Spawns a reviewer sub-agent to score the implementation on test coverage and code quality.
5. **Merges or Retries** — If gates pass, code is merged. If not, the implementer gets feedback and tries again (up to 3 attempts).

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

### `/tdd <request | id>`
Starts a full TDD workflow.
- **Pre-planned**: `/tdd 1` or `/tdd epic-01` (Loads richer metadata from `WorkItems/epic-01-*.md`)
- **Fuzzy Match**: `/tdd auth` (Matches any epic file containing 'auth')
- **Ad-hoc**: `/tdd "Add a secure JWT endpoint"` (On-the-fly planning for immediate tasks)
- **What happens**: The system loads the epic, parses **Acceptance Criteria**, **Security requirements**, and **Tests**, and injects them into the implementer's system prompt.

### `/plan <request>`
Decomposes a project into "World-Class" Epics and WorkItems.
- **Enhanced Planning**: Generates structured markdown files including per-task **Security Considerations**, **Dev Notes**, and **Mock/Test Case suggestions**.
- **Output**: Creates a `WorkItems/` directory at the project root.
- **Analysis Integration**: Automatically runs `/analyze` first to ensure the architect has a fresh blueprint of the codebase.
- **Context Awareness**: The planner reads existing `agents.md` and `README-tech.md` to ensure any new epics follow your project's architectural standards.

### `/research <topic> [--bg]`
Launches an autonomous Deep Research agent to browse the web and watch videos.
- **Tools**: The agent uses `fetch_and_convert_html` (Readability + Turndown) for clean reading and `parse_youtube_transcript` for lightning-fast transcript fetching.
- **Tool Inheritance**: Inherits all your Pi extensions (including `context-mode` for memory management and `searxng` for web search).
- **Loop**: It searches, identifies missing info, and repeats up to 3 times before synthesizing a final report.
- **Background Mode**: Use `--bg` to run the researcher in the background if it's a long task.
- **Output**: Generates a structured markdown file in results to `Research/<Topic>.md`.
- **TUI Integration**: Automatically opens the research report in your editor once finished.

### `/analyze`
- **Benefit**: Caches a "blueprint" of the repository that the Planner and Architect use to generate more accurate tasks.
- **Output**: Stores analysis in `.tdd-workflow/analysis/`.
- **Languages**: Supports TypeScript (AST), C# (Roslyn), and C++ (Tree-Sitter).

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
4.  **Execute**: Run `/tdd 1`. The orchestrator will **parse the rich metadata** from the markdown and inject it directly into the sub-agent's prompt, ensuring the generated code hits every requirement (Security, Acceptance, Tests).

## Under the Hood: Agentic Sessions

Unlike legacy MCP servers, this orchestrator uses **ephemeral agent sessions** (`createAgentSession`). 

- **Statefulness**: Within a single "attempt", the Implementer agent can freely read files, run tests, and fix its own errors multiple times before submitting for validation.
- **Tool Access**: Agents have access to the same native tools as you: `read`, `write`, `edit`, and `bash`.
- **MCP Tool Inheritance**: Sub-agents inherit tools from the parent Pi session (via `pi-mcp-adapter`). If you have `context-mode` or `search` installed, the implementer can use them.
- **Wait/Initialization**: When spawning a sub-agent, the system waits for 2 seconds to allow async extensions (like MCP servers) to establish their RPC bounds before the agent starts its work.

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

## Agent Prompts Reference

For developers looking to tune their models, the exact system prompts are provided in the [README.md#core-agents--prompts](file:///home/stephen/dev/tdd-pi-plugin/README.md#core-agents--prompts) for reference.

## Troubleshooting

| Issue | Solution |
|---|---|
| Command not found | Ensure you ran `npm run build` and `pi install local:.` correctly. |
| Model "X" not found | Check `models.config.json` and ensure your llama.cpp server is running in "Router Mode". |
| Workflow hangs | Check `.tdd-workflow/logs/` for details. Usually means the LLM is stuck or local VRAM is exhausted. |
| Quality gates always fail | Verify your `package.json` scripts (`test`, `build`) work manually first. |
| JSON parsing failure | Some models struggle with the structured output of `/plan`. Use a more capable model (like Gemma 2 27B or Claude 3.5 Sonnet) for the `project-plan` role. |

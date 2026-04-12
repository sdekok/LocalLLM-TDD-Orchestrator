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
npm install
npm run build        # TypeScript only
# Optional: build the Roslyn C# analyzer (requires .NET 10 SDK)
npm run build:csharp
# Or build everything at once
npm run build:all
```

### 2. Register with Pi
```bash
pi install local:.
```

### 3. Configure Models

Run the interactive setup wizard from inside any Pi session:

```
/setup
```

Or to save as a system-wide default that applies to all your projects:

```
/setup --global
```

## Slash Commands

### `/setup [--global]`

Configures model routing for all agent roles.

1. Discovers available models from your llama.cpp server.
2. Lets you select which models to use and give them friendly names.
3. Asks whether each model has thinking/reasoning mode enabled.
4. Walks through assigning a model to each agent role (plan, project-plan, implement, review, research).
5. Saves to `./models.config.json` (project) or `~/.config/tdd-workflow/models.config.json` (global).

If both a global and project config exist they are **merged** — the project config wins on any conflict, so you only need to declare what differs from your global defaults.

### `/tdd <request | id>`

Starts a full TDD workflow.

- **Pre-planned**: `/tdd 1` or `/tdd epic-01` — loads richer metadata from `WorkItems/epic-01-*.md`
- **Fuzzy match**: `/tdd auth` — matches any epic file containing 'auth'
- **Ad-hoc**: `/tdd "Add a secure JWT endpoint"` — on-the-fly planning

The system loads the epic, parses **Acceptance Criteria**, **Security requirements**, and **Test suggestions**, and injects them into the implementer's system prompt.

### `/plan <request>`

Decomposes a project or feature into Epics and WorkItems.

- Generates structured markdown files including per-task Security Considerations, Dev Notes, and test suggestions.
- Creates a `WorkItems/` directory at the project root.
- Runs `/analyze` first if the codebase blueprint is stale.
- If the model doesn't return structured JSON on the first attempt, automatically retries with an explicit follow-up prompt — works reliably in passthrough mode (no config) as well as with configured models.

### `/research <topic> [flags]`

Launches an autonomous Deep Research agent.

- `--bg` — run in the background
- `--shallow` — single-pass synthesis (no iterative deepening)
- `--time N` — cap at N minutes (default 30)
- `--resume [folder]` — continue a previous session

The agent searches, reads pages, and synthesizes findings into a structured markdown report in `Research/<topic>/`.

### `/analyze`

Runs a fresh architectural analysis and caches it in `.tdd-workflow/analysis/`. The Planner and Implementer agents read this cache automatically.

Supports TypeScript (AST via ts-morph), C# (Roslyn), and C++ (Tree-Sitter).

## Model Configuration

Routing is driven by `models.config.json`. The orchestrator checks two locations and merges them — the project config wins on any conflict:

| Location | Purpose |
|---|---|
| `~/.config/tdd-workflow/models.config.json` | System-wide defaults (shared across all projects) |
| `<project>/models.config.json` | Project-specific overrides |

Use `/setup` to create or update either file interactively. You can also edit the JSON directly.

### `enableThinking`

Set `"enableThinking": true` on any model profile to:
- Activate Pi's reasoning mode (`setThinkingLevel('medium')`) for that model's sessions.
- Enable the thinking-block history filter, which strips reasoning traces from prior turns in multi-turn conversations (prevents thinking quality degradation).

Reasoning-token injection (e.g. `<|think|>`) is handled by your chat template at the llama.cpp level — no prompt mutations happen in the plugin.

### Cloud Providers

```json
{
  "modelId": "anthropic/claude-sonnet-4",
  "provider": "openrouter",
  "apiKeyEnvVar": "OPENROUTER_API_KEY"
}
```

API keys must be supplied via environment variables. The `apiKeyEnvVar` field names the environment variable to read. Never hardcode secrets in config files.

> `models.config.json` and `models.config.local.json` are in `.gitignore` by default.

### No Config / Passthrough Mode

If no config file is found anywhere, the orchestrator runs in **passthrough mode** — Pi's currently active model is used for all sub-agents. Planning and research commands will automatically retry with an explicit JSON prompt if the model doesn't produce structured output on the first attempt, so basic usage works without any configuration.

## Project Planning Lifecycle

For complex features, the recommended flow is:

1. **Plan**: `/plan "Feature description"` — generates epics with acceptance criteria, security notes, and test suggestions.
2. **Review**: Open the generated `WorkItems/epic-XX.md` files and edit if needed.
3. **Refine**: Update `agents.md` if the architect identified new cross-cutting constraints.
4. **Execute**: `/tdd 1` — the orchestrator parses all rich metadata and injects it into the sub-agent's prompt.

## Quality Gates

The orchestrator does **not** ask an AI if the code is good enough. It runs deterministic checks:

| Gate | Type | What It Checks |
|---|---|---|
| **Lens Analysis** | Blocking | Structural bugs (ast-grep) + deep type errors (LSP) |
| **TypeScript** | Blocking | `npx tsc --noEmit` — any type errors fail the gate |
| **Tests** | Blocking | Auto-detects test framework and runs the suite |
| **Coverage** | Blocking | Enforces thresholds defined in `package.json` |
| **Lint** | Non-blocking | ESLint warnings are logged but don't block |
| **File Safety** | Blocking | Ensures files were only written to expected directories |

### Coverage Thresholds

Add `tddConfig` to your `package.json` to enforce blocking coverage gates:

```json
{
  "tddConfig": {
    "coverageThresholds": {
      "lines": 85,
      "functions": 80,
      "branches": 75
    }
  }
}
```

## Safety & Controls

- **Git Sandboxing**: Every subtask runs in its own branch. No code is merged unless all deterministic gates pass.
- **Circuit Breaker**: If 3 consecutive subtasks fail completely (retries exhausted), the entire workflow stops.
- **Loop Detection**: If an agent produces nearly identical changes (>90% similarity) across attempts, the system bails early and flags the task for manual intervention.

## Troubleshooting

| Issue | Solution |
|---|---|
| Command not found | Ensure you ran `npm run build` and `pi install local:.` |
| No models discovered | Check that llama.cpp is running and the URL is correct (`LLAMA_CPP_URL` env var or enter it when prompted by `/setup`) |
| Model "X" not found | Run `/setup` to reconfigure, or check `models.config.json` routing keys match the model keys in `models` |
| Workflow hangs | Check `.tdd-workflow/logs/` for details — usually the LLM is stuck or VRAM is exhausted |
| Quality gates always fail | Verify your `package.json` scripts (`test`, `build`) work manually first |
| JSON parsing failure in /plan | The planner will automatically retry once with an explicit JSON prompt. If it still fails, the active model may not be capable of structured output — configure a stronger model via `/setup` |
| Lens gate always fails in CI | Set `LENS_FAIL_POLICY=fail-open` if Lens is not installed, or ensure `pi-lens` is in your project's dependencies |
| Workflow failed, unclear why | Search `.tdd-workflow/logs/` for the workflow ID shown at startup |

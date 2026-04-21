# User Guide — TDD Agentic Workflow (Pi Native)

## Overview

The TDD Agentic Workflow orchestrator is a native **Pi Extension** that automates feature implementation through ephemeral sub-agent sessions. You describe what you want, and the system:

1. **Plans** — Breaks your request into testable subtasks, researching best practices via web search.
2. **Implements** — Spawns a headless Pi sub-agent that writes tests and code natively using `read`, `edit`, and `bash` tools.
3. **Validates** — Runs deterministic quality gates on the sub-agent's work: Lens (structural + type), TypeScript compile, test suite, coverage (opt-in), lint, file-safety.
4. **Reviews** — Spawns a reviewer sub-agent to score the implementation on test coverage and code quality.
5. **Merges or Retries** — If gates + review pass, code is merged. If not, the implementer gets feedback and tries again (up to 5 attempts per task; a neutral arbiter then decides approve/continue/escalate).

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

### `/tdd <request | id> [retry | resume | continue | task <id>]`

Starts or resumes a TDD workflow.

**Starting:**
- `/tdd 1` or `/tdd epic-01` — loads `WorkItems/epic-01-*.md` with full metadata
- `/tdd auth` — fuzzy match on any epic file containing 'auth'
- `/tdd "Add a secure JWT endpoint"` — on-the-fly planning (no WorkItems/ needed)

The system parses **Acceptance Criteria**, **Security requirements**, and **Test suggestions** from the epic file and injects them into the implementer's system prompt. Before implementation begins, each work item is refined into granular technical steps by a planning pass, and the breakdown is posted to chat.

**Failure & resume subcommands:**

When any task exhausts its attempts (5 by default), the workflow **stops immediately** and posts a chat message with the branch name, state file location, and next-step commands. The failed branch is preserved exactly as the agent left it — nothing is cleaned up — so you can inspect, fix manually, or hand it to another agent.

- `/tdd 1 resume` — retry failed tasks with reviewer feedback **preserved** _(recommended)_
- `/tdd 1 retry` — retry failed tasks from a clean slate (feedback cleared)
- `/tdd 1 continue` — leave failed tasks as-is and resume from the next pending task
- `/tdd 1 task WI-36` — run a single task (retry mode, feedback cleared)
- `/tdd 1 task WI-36 resume` — run a single task (resume mode, feedback preserved)

> **Note**: `/tdd 1` (no subcommand) always starts fresh, resetting state for that epic.

### `/tdd:pause`, `/tdd:stop`, `/tdd:resume`

Interrupt a running TDD workflow from chat — no need to kill Pi.

**`/tdd:pause`** — graceful stop, designed to be resumed.

- Lets the current agent turn finish naturally (typically seconds-to-minutes, not the full timeout).
- Marks the currently-running task as `paused`. Other tasks stay `pending`.
- **Preserves everything**: the WIP branch, the attempt counter, and any reviewer feedback already accumulated.
- Use when you need to step away, restart, or context-switch and want to continue exactly where the agent was.

**`/tdd:stop`** — immediate abort, repo returns to clean state.

- Force-disposes the active agent session (no waiting for the model to finish its turn).
- Rolls the repo back to the base branch.
- Resets the current task to `pending` with attempts=0 and feedback cleared — the repo looks like the task never ran.
- Other tasks in the epic are untouched.
- Use when the current task is going nowhere and you want a clean slate — e.g. the planner mis-scoped the work, or you want to re-plan by hand.

**`/tdd:resume`** — pick up a paused workflow.

- Scans state for `paused` tasks and resumes them in resume mode (branch reused, feedback preserved, attempt counter preserved).
- If there are no paused tasks, the command is a no-op with a friendly notice. Use `/tdd N resume` instead for failed tasks.

**Pause vs stop — quick reference:**

| | `/tdd:pause` | `/tdd:stop` |
|---|---|---|
| Current agent turn | finishes naturally | aborted immediately |
| Current task status | `paused` | `pending` (reset) |
| Task branch | preserved | rolled back |
| Attempt counter | preserved | reset to 0 |
| Reviewer feedback | preserved | cleared |
| How to continue | `/tdd:resume` | `/tdd N` (fresh) or `/tdd N resume` (next pending) |

### `/tdd:project-cleanup`

Audits every quality gate across the whole project **before any agent runs**, summarises the failing gates in chat, then hands a structured cleanup brief to the standard TDD executor. The on-the-fly planner decomposes "fix these specific failures" into per-gate subtasks, each of which goes through the normal implement → review → merge loop.

- The implementer is instructed to only fix failures in files it is already modifying, so cleanup stays scoped and doesn't cause unrelated drift.
- Useful after onboarding a stale codebase, after a large refactor landed externally, or before starting a new feature on top of a currently-red tree.

### `/tdd:test`

Runs the project's test suite using the same runner + command the TDD executor uses internally (so results match what the gates will see). Posts the summary and last 4k of output to chat.

- Auto-detects Vitest from `package.json#devDependencies`.
- Uses `<pkgManager> run test` when a `test` script is defined, else falls back to `npx vitest run`.
- Useful as a quick sanity check before kicking off `/tdd` on a task, or to inspect what failures the gates will report.

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

**Routing roles**: the full set of roles is `plan`, `project-plan`, `implement`, `review`, `arbitrate`, `research`, plus optional `design`, `design_review`, `analyze`, `document`. `/setup` configures the five commonly-used ones (plan, project-plan, implement, review, research). Anything unrouted falls back to the `plan` model — so the arbiter uses the plan model by default unless you add `"arbitrate": "some-model"` to the routing yourself.

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
| **Coverage** | Blocking _(opt-in)_ | Only runs when `tddConfig.coverageThresholds` is set in `package.json` — otherwise skipped entirely |
| **Lint** | Non-blocking | ESLint warnings are logged but don't block |
| **File Safety** | Blocking | Ensures files were only written to expected directories |

### Coverage Thresholds (opt-in)

The coverage gate is **disabled by default**. Add `tddConfig.coverageThresholds` to your `package.json` to turn it on as a blocking gate:

```json
{
  "tddConfig": {
    "coverageThresholds": {
      "lines": 85,
      "functions": 80,
      "branches": 75,
      "statements": 80
    }
  }
}
```

Only the thresholds you specify are enforced. A project without this key has no coverage-based failure mode — useful when you're starting out and haven't written tests yet.

## Safety & Controls

- **Git Sandboxing**: Every subtask runs in its own branch (`tdd-workflow/WI-N`). No code is merged unless all deterministic gates pass.
- **Stop on failure**: Any task that exhausts all its attempts stops the workflow immediately. You must explicitly resume with `/tdd <n> retry`, `/tdd <n> resume`, or `/tdd <n> continue`. The WIP branch is preserved for inspection.
- **User interrupt**: `/tdd:pause` and `/tdd:stop` let you halt an active workflow from chat without killing Pi. Pause preserves the WIP for later; stop rolls the current task back.
- **No destructive cleanup**: Rollback only switches back to the original branch. The sandbox branch is never deleted or cleaned automatically — you decide what to do with it.
- **Circuit Breaker**: If 3 consecutive subtasks fail completely (retries exhausted), the entire workflow stops.
- **Loop Detection**: If an agent produces nearly identical changes (>90% similarity) across attempts, the system bails early and flags the task for manual intervention.
- **Shutdown cleanup**: When Pi exits (Ctrl-C, SIGTERM, unhandled error), any live sub-agent sessions are disposed before the process terminates — prevents llama.cpp slots from being left occupied.

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
| Task failed, want to retry | Run `/tdd <epic> retry` — resets failed tasks and resumes |
| Task failed, want to skip it | Run `/tdd <epic> continue` — skips failed tasks and proceeds |
| Need to step away mid-workflow | Run `/tdd:pause`, then `/tdd:resume` later — WIP branch and feedback are kept |
| Current task is going nowhere | Run `/tdd:stop` — rolls the task back to base so you can re-plan or edit by hand |
| `/tdd:resume` says "no paused tasks" | Your task failed rather than being paused — use `/tdd <epic> resume` instead |
| Wrong epic files after /plan | Re-run `/plan` — each epic now gets a fresh session, preventing cross-contamination from prior epics' JSON |
| Quality gates crash (lens-bridge) | Run `npm run build` in the plugin directory to ensure `dist/interfaces/pi/lens-bridge.js` is present |

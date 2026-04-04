# User Guide — TDD Agentic Workflow

## Overview

The TDD Agentic Workflow orchestrator automates feature implementation through your Pi Coding Agent. You describe what you want, and the system:

1. **Plans** — Breaks your request into testable subtasks, researching best practices via web search
2. **Implements** — Writes tests first, then code, in a sandboxed git branch
3. **Validates** — Runs deterministic quality gates (TypeScript compilation, test suite, linting)
4. **Reviews** — An adversarial LLM reviewer scores the implementation on test coverage, integration, error handling, and security
5. **Merges or retries** — If gates pass, the code is merged with a rich commit message. If not, the implementer gets the error output and tries again (up to 3 attempts)
6. **Detects loops** — If the agent produces nearly identical output across attempts (>90% similarity), it bails early instead of wasting compute

## First-Time Setup

### 0. MCP Servers & Context Integration (Pi)

The orchestrator operates seamlessly with Pi Coding Agent's `mcp.json`.
- **Enriched Context**: If you have `context-mode` registered in Pi, the TDD workflow automatically utilizes its memory index to deeply analyze your repository using `ctx_search`.
- **Knowledge Share**: At the completion of each subtask, the orchestrator updates `context-mode` via `ctx_index`, ensuring standard Pi chats retain knowledge of your TDD changes.
- **Headless MCP Usage**: If you are using this plugin standalone (Cursor, Windsurf), you can define a `.tdd-workflow/mcp.json` in your project root to connect to MCP servers like `searxng`.

### 1. Start Your Local Infrastructure

**llama.cpp in Router Mode** (required):
```bash
./llama-server --models-dir /path/to/your/gguf-models --host 0.0.0.0 --port 8080
```

This auto-discovers all GGUF files in the directory and loads them on demand.

**SearXNG** (recommended, for web search):
```bash
docker run -d --name searxng --restart unless-stopped \
  -p 8888:8080 -e SEARXNG_BASE_URL=http://localhost:8888 \
  searxng/searxng
```

### 2. Configure Models

Run the interactive wizard:
```bash
cd /path/to/pi-coding-agent
npx tsx scripts/setup-wizard.ts
```

The wizard will:
- Connect to your llama.cpp server and list available models
- Let you name each model and set its architecture (MoE vs dense)
- Configure sampling parameters (temperature, top_k, top_p, etc.)
- Map models to agent roles (planner, implementer, reviewer, researcher)
- Save everything to `models.config.json`

**Or configure manually** — copy and edit the example:
```bash
cp models.config.example.json models.config.json
```

### 3. Using Cloud Models (Optional)

You can add OpenRouter or OpenAI models alongside your local ones. In `models.config.json`:

```json
{
  "cloud-research": {
    "name": "Claude 4 Sonnet (via OpenRouter)",
    "ggufFilename": "",
    "modelId": "anthropic/claude-sonnet-4",
    "provider": "openrouter",
    "apiKeyEnvVar": "OPENROUTER_API_KEY",
    "contextWindow": 200000,
    "maxOutputTokens": 16384,
    "architecture": "dense",
    "speed": "medium",
    "samplingParams": { "temperature": 0.1 }
  }
}
```

Set the environment variable: `export OPENROUTER_API_KEY=sk-or-...`

Then in your routing, assign it to a role: `"research": "cloud-research"`

## Using the Workflow

### Starting a Workflow

Tell Pi what you want to build and which project to work on:

> "Start a TDD workflow to add user authentication with JWT tokens to the Express app at /home/stephen/projects/my-api"

Pi will call the `start_tdd_workflow` MCP tool with your request and project path. The orchestrator runs in the background.

### Epic-Level Workflows

For larger features, create a feature branch first:

```bash
cd /home/stephen/projects/my-api
git checkout -b feature/jwt-auth
```

Then start the workflow. All subtask merges land on `feature/jwt-auth`, giving you a clean commit history:

```
feature/jwt-auth
  ├── TDD: Create user model with validation
  ├── TDD: Add password hashing with bcrypt
  ├── TDD: Create JWT token generation
  ├── TDD: Build login endpoint
  └── TDD: Add auth middleware
```

When the workflow completes, open a PR from `feature/jwt-auth` → `main` and review the aggregate result.

### Checking Progress

> "Check the status of the TDD workflow for /home/stephen/projects/my-api"

Pi will show you:
- How many subtasks were created
- Which are pending, in progress, completed, or failed
- Any feedback from failed attempts

### Resuming After Interruption

If the process is interrupted (machine restart, power loss), your progress is saved:

> "Resume the TDD workflow for /home/stephen/projects/my-api"

This picks up from the last pending task. To also retry previously failed tasks:

> "Resume the TDD workflow for /home/stephen/projects/my-api and retry any failed tasks"

## How Quality Gates Work

The orchestrator does **not** ask an AI if the code is good enough. Instead, it runs deterministic checks:

| Gate | Type | What It Checks |
|---|---|---|
| **TypeScript** | Blocking | `npx tsc --noEmit` — any type errors fail the gate |
| **Tests** | Blocking | Auto-detects test framework (vitest, jest, mocha, ava, node:test) and runs the suite |
| **Lint** | Non-blocking | ESLint warnings are logged but don't block |
| **File Safety** | Blocking | Ensures files were only written to expected directories (src/, tests/) |

If any **blocking** gate fails, the error output is fed back to the implementer as context for the next attempt. The LLM reviewer only runs **after** gates pass, and its feedback is advisory.

### Test Metrics

After tests run, the orchestrator automatically parses test counts from the runner output. This is included in every commit message so you can see at a glance how many tests were added:

```
Tests: 47/47 passed
```

Supports vitest, jest, mocha, and node:test output formats.

### Code Coverage

If you have a coverage tool installed, coverage is **automatically** detected and included:

- **Vitest**: Install `@vitest/coverage-v8` → coverage runs automatically
- **Jest**: Built-in `--coverage` flag is added
- **c8 / nyc**: Detected from devDependencies
- **Custom script**: If you have a `test:coverage` or `coverage` script in package.json, it's used instead

Coverage appears in the commit message:
```
Coverage: 87.3% lines, 72.1% branches, 91.0% functions
```

If no coverage tool is installed, coverage is simply omitted — no error, no noise.

## Safety Guards

The orchestrator has three layers of protection against runaway execution:

### 1. Loop Detection (Per Attempt)
If the implementer produces output that is >90% similar to the previous attempt, it means the agent is stuck in a loop. The system **bails immediately** instead of wasting the remaining attempts on identical output.

### 2. Time Budget (Per Task)
Each subtask has a 10-minute total time budget across all attempts. If exceeded, the task is marked as failed and the workflow continues.

### 3. Circuit Breaker (Workflow-Level)
If 3 consecutive tasks fail (not just individual attempts — entire tasks), the workflow stops. This catches systemic issues like a misconfigured model, missing project dependencies, or a fundamentally broken build. Resume with `retryFailed=true` after fixing the root cause.

## Commit Messages

Every merge commit is **self-documenting** with full quality details:

```
TDD: Create JWT token generation

---
Attempt: 1

Quality Gates:
  ✅ typescript (blocking)
  ✅ tests (blocking)
  ⚠️ lint

Tests: 47/47 passed
Coverage: 87.3% lines, 72.1% branches, 91.0% functions

Reviewer Score: 17/20
Reviewer: Good test coverage, clean error handling. Minor: could use a constant for expiry.

Files: src/auth/jwt.ts, tests/auth/jwt.test.ts
```

This means your git log and PRs are fully auditable without reading log files.

## Workflow State

All state is stored in your project under `.tdd-workflow/`:
- `state.json` — Current subtask list, statuses, and feedback
- `logs/` — Timestamped log files for debugging

To reset completely, delete the directory:
```bash
rm -rf /path/to/your/project/.tdd-workflow
```

## Design Agents (Optional)

For UI-heavy projects, two additional agent roles are available:

- **Designer** (`design`): Generates component specifications, layout prototypes, and suggests design tokens
- **Design Reviewer** (`design_review`): Checks for component duplication, design system consistency, and naming conventions

Map them in your `models.config.json` routing:
```json
{
  "routing": {
    "plan": "gemma-4-dense",
    "implement": "qwen-moe",
    "review": "gemma-4-dense",
    "research": "qwen-dense",
    "design": "gemma-4-dense",
    "design_review": "gemma-4-dense"
  }
}
```

If not mapped, they fall back to the planner model automatically.

## Troubleshooting

| Problem | Solution |
|---|---|
| "No model configuration found" | Run `npx tsx scripts/setup-wizard.ts` or copy `models.config.example.json` to `models.config.json` |
| Workflow hangs | Check `.tdd-workflow/logs/` for timeout errors. Increase `maxOutputTokens` in config or check llama.cpp VRAM usage |
| LLM returns malformed JSON | The parser handles most cases (trailing commas, comments, prose). If persistent, try a larger/smarter model for that role |
| Quality gates always fail | Check that `package.json` has correct test/build scripts and that existing tests pass before starting a workflow |
| MCP server doesn't connect | Check `~/.pi/agent/mcp.json` points to the correct `dist/mcp-server/index.js` path |
| "Loop detected" on every task | The model can't solve the problem — try a different model for the implementer role or simplify the request |
| "Circuit breaker" triggers | Something systemic is wrong — check if the project builds and tests pass before the workflow, and verify your model config |

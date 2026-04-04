# TDD Agentic Workflow Orchestrator

A persistent, agentic TDD workflow engine that automates feature implementation using local LLMs (via llama.cpp) or cloud providers (via OpenRouter). Runs as an MCP server for the Pi Coding Agent.

## How It Works

```
Pi says "implement JWT auth"
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
   │  (fast MoE)  │     │  tsc → tests       │
   └──────┬──────┘     │  → lint → fs       │
          │             │  + test metrics     │
          │             │  + coverage (opt.)  │
          │             └──────┬────────────┘
          │                    │ Pass/Fail
          ▼                    ▼
   ┌─────────────┐     Algorithm decides:
   │  Reviewer    │     merge or retry
   │  (advisory)  │     (not the AI)
   └─────────────┘
```

Each subtask runs in a **git branch sandbox**. If quality gates fail, the branch is rolled back. If they pass, the reviewer provides advisory feedback. The **algorithm** makes the final merge decision.

Every merge commit includes: quality gate results, test counts, code coverage (if configured), reviewer score, and files changed.

## Safety & Runaway Protection

| Guard | What It Catches | Behavior |
|---|---|---|
| **Max attempts** (3/task) | Persistent failures | Marks task as failed, moves to next |
| **Output similarity** (>90%) | Agent stuck in a loop | Bails immediately — doesn't waste remaining attempts |
| **Time budget** (10 min/task) | LLM hangs, runaway tool calls | Breaks the attempt loop, marks task as failed |
| **Circuit breaker** (3 consecutive failures) | Systemic problems | Stops entire workflow with clear message |

## Quick Start

### 1. Prerequisites

- **Node.js 20+**
- **llama.cpp** running in Router Mode:
  ```bash
  ./llama-server --models-dir /path/to/your/models --host 0.0.0.0 --port 8080
  ```
- **SearXNG** (optional, for web search):
  ```bash
  docker run -d --name searxng --restart unless-stopped \
    -p 8888:8080 -e SEARXNG_BASE_URL=http://localhost:8888 \
    searxng/searxng
  ```

### 2. Install & Configure

```bash
cd pi-coding-agent
npm install
npx tsx scripts/setup-wizard.ts   # Interactive model configuration
npm run build
```

The wizard connects to your llama.cpp server, discovers available models, and creates `models.config.json`.

### 3. Deploy
You can deploy the orchestrator natively as a **Pi Extension** or generically as an **MCP Server**.

#### Option A: Native Pi Extension (Recommended)
Starting in v2.1, the orchestrator includes a native extension for `@mariozechner/pi-coding-agent`. This gives you slash commands and a real-time UI dashboard.

```bash
# Register the package with Pi
pi install local:/path/to/pi-coding-agent
```

Simply launch Pi inside any project and type:
```
/tdd Add JWT authentication middleware
```
The workflow will run in the background with a shiny real-time progress UI!

To analyze a repository's architecture without starting a workflow:
```
/analyze
```

#### Option B: MCP Server
If you are using cursor, windsurf, or pi in headless mode, deploy via MCP:

Add to `~/.pi/agent/mcp.json` or your cursor MCP config:
```json
{
  "mcpServers": {
    "tdd-workflow": {
      "command": "node",
      "args": ["/path/to/tdd-agentic-workflow/dist/interfaces/mcp/index.js"],
      "env": {
        "LLAMA_CPP_URL": "http://localhost:8080/v1",
        "SEARXNG_URL": "http://localhost:8888"
      }
    }
  }
}
```

Pi will call `start_tdd_workflow`, the orchestrator runs in the background, and you can check progress with `check_workflow_status`.

#### MCP Ecosystem Connections
The TDD Orchestrator acts as an **MCP Client** itself! 
- **In Pi Mode**: It reads `~/.pi/agent/mcp.json` and connects to your other servers (like `context-mode` for indexing/searching the codebase).
- **In Headless Mode**: You can create `.tdd-workflow/mcp.json` in your project root pointing to external servers, and it will dynamically pull their tools into the workflow (e.g. passing URLs through `ctx_fetch_and_index`).

## MCP Tools

| Tool | Description |
|---|---|
| `start_tdd_workflow` | Start a new workflow. Requires `request` (what to build) and `projectDir` (absolute path). |
| `resume_tdd_workflow` | Resume from where you left off. Optional `retryFailed` flag to retry exhausted tasks. |
| `check_workflow_status` | Get summary of all subtasks: pending, in progress, completed, failed. |
| `analyze_project` | Run architecture code analysis on a project. Caches patterns for the workflow orchestrator. |

## Model Configuration

Models are configured in `models.config.json` (not hardcoded). Run the setup wizard or copy and edit the example:

```bash
cp models.config.example.json models.config.json
```

Each model profile supports:
- **Provider**: `local` (llama.cpp), `openrouter`, `openai`, or `custom`
- **Architecture**: `dense` or `moe`
- **Sampling params**: `temperature`, `top_k`, `top_p`, `min_p`, `repeat_penalty`
- **Cloud models**: `modelId`, `apiKey` / `apiKeyEnvVar`

Models are mapped to roles:
- `plan` → Strong reasoning (dense model)
- `implement` → Fast throughput (MoE model)
- `review` → Careful analysis (dense model)
- `research` → Broad knowledge (dense or cloud)
- `design` → UI/UX prototyping (optional)
- `design_review` → Design system consistency (optional)

## Agent Roles

| Agent | Purpose | Default Model |
|---|---|---|
| **Planner** | Breaks requests into TDD subtasks, researches best practices | Dense (reasoning) |
| **Implementer** | Writes tests first, then code to pass them | MoE (speed) |
| **Reviewer** | Adversarial code review with 4-criteria scoring rubric | Dense (analysis) |
| **Designer** | Generates component specs and UI prototypes | Dense (reasoning) |
| **Design Reviewer** | Checks design system consistency, flags component duplication | Dense (analysis) |

## Quality Gates

Quality gates are **deterministic** — no AI decides pass/fail:

| Gate | Type | What It Checks |
|---|---|---|
| **TypeScript** | Blocking | `npx tsc --noEmit` — any type errors fail the gate |
| **Tests** | Blocking | Auto-detects framework (vitest, jest, mocha, ava, node:test) and runs full suite |
| **Lint** | Non-blocking | ESLint warnings logged but don't block |
| **File Safety** | Blocking | Files only written to expected directories (src/, tests/) |

### Test Metrics & Coverage

After tests run, the orchestrator parses test counts from the runner output:
- **Vitest**: `Tests  47 passed (47)` → `47/47 passed`
- **Jest**: `Tests: 1 failed, 10 passed, 11 total`
- **Mocha**: `10 passing, 2 failing`
- **node:test**: `# tests 5, # pass 4`

If a coverage tool is installed (`@vitest/coverage-v8`, `jest --coverage`, `c8`, or `nyc`), coverage is automatically run and included in the commit message.

## Commit Messages

Every merge commit is self-documenting:

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
Reviewer: Good test coverage, clean error handling.

Files: src/auth/jwt.ts, tests/auth/jwt.test.ts
```

## Architecture

```
src/
  mcp-server/index.ts          # MCP tool definitions (start/resume/status)
  orchestrator/
    executor.ts                 # Main TDD loop with loop detection + circuit breaker
    state.ts                    # Persistent workflow state (.tdd-workflow/state.json)
    quality-gates.ts            # Deterministic gates + test metrics + coverage parsing
    sandbox.ts                  # Git branch isolation + rich commit messages
  agents/
    planner.ts                  # Task breakdown with search-powered research
    implementer.ts              # TDD implementation with workspace context
    reviewer.ts                 # Adversarial reviewer with scoring rubric
    designer.ts                 # UI/UX prototyping agent
    design-reviewer.ts          # Design system consistency checker
  llm/
    client.ts                   # Multi-provider LLM client with timeouts + JSON parsing
    model-router.ts             # Config-driven model selection
  mcp/
    client-pool.ts              # Internal MCP Client handling external tool discovery
  context/
    gatherer.ts                 # Workspace snapshot assembly
  search/
    searxng.ts                  # SearXNG search client
  utils/
    logger.ts                   # File-based logger (MCP-safe)
scripts/
  setup-wizard.ts               # Interactive model configuration CLI
tests/                          # 112 unit + integration tests (vitest)
```

## Development

```bash
npm run test         # Run all tests
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
npm run start        # Run MCP server directly
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LLAMA_CPP_URL` | `http://localhost:8080/v1` | llama.cpp server URL |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG search URL |
| `OPENROUTER_API_KEY` | — | API key for OpenRouter models |
| `OPENAI_API_KEY` | — | API key for OpenAI models |
| `TDD_WORKFLOW_CONFIG_DIR` | — | Override config file search directory |

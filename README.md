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
| **Time budget** (10 min/task) | LLM hangs, runaway tool calls | Breaks the attempt loop, marks task as failed |
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

> **API Keys**: The `apiKey` field is **not** supported in model profiles. API keys must be supplied via environment variables. Use `apiKeyEnvVar` in the model profile to specify which environment variable holds the key (e.g. `"apiKeyEnvVar": "OPENROUTER_API_KEY"`).

> **Security**: `models.config.json` and `models.config.local.json` are listed in `.gitignore` to prevent accidental secret commits. Never hardcode API keys in these files.

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
npm run build        # Compile TypeScript only
npm run build:csharp # Build the Roslyn C# analyzer (requires .NET 10 SDK)
npm run build:all    # Full build: C# analyzer + TypeScript
npm run dev          # Watch mode
```

## Core Agents & Prompts

The orchestrator uses a multi-agent choreography to ensure quality and safety. Each agent is a specialized Pi sub-agent session with its own system prompt.

<details>
<summary><b>Project Planner Agent</b> (/plan)</summary>

Used for strategic project decomposition optimized for small LLMs.

```markdown
You are a strategic technical architect and project manager. 
Your goal is to take a high-level project request and plan it thoroughly before any coding begins.

## Context Mode (MANDATORY)
Default to context-mode (\`ctx_execute_file\`) for analyzing codebase state.

### Your Objectives
1. **Understand Context**: Use \`ctx_execute_file\` and \`bash\` to understand the current project structure. **Examine \`.tdd-workflow/analysis/\` for deep architectural insights before planning.**
2. **Decompose into Epics**: Break the project into as many small, logical Epics as needed for extreme clarity. More small epics are better than few large ones.
3. **Decompose into Work Items**: Break each Epic into "Small Slices". A human should ideally be able to complete a work item in less than a day. They must be atomic, verifiable, and manageable for a small model.
4. **Define Architecture**: Identify cross-cutting architectural decisions.
5. **Return Structured Plan**: You must return your entire plan as a single, valid JSON object.

### Clarification Protocol
If you encounter ambiguity, call the \`ask_user_for_clarification\` tool.

### Output Format
{
  "reasoning": "Step-by-step reasoning for this breakdown, identifying potential blockers or method-level changes",
  "summary": "string",
  "epics": [
    {
      "title": "string",
      "slug": "string",
      "description": "string",
      "workItems": [
        {
          "id": "WI-1",
          "title": "string",
          "description": "...",
          "acceptance": ["..."],
          "tests": ["..."]
        }
      ]
    }
  ],
  "architecturalDecisions": ["string"]
}
```
</details>

<details>
<summary><b>Deep Researcher Agent</b> (/research)</summary>

Used for autonomous web research, video transcript parsing, and technical synthesis.

```markdown
You are a Deep Research Agent. Your goal is to deeply investigate the user's topic by utilizing search and reading tools, and distill your findings into a comprehensive markdown report.

### Your Tools
1. 'fetch_and_convert_html' to extract readable content from articles and documentation.
2. 'parse_youtube_transcript' to quickly ingest tech talks and video tutorials.
3. Inherited tools from the environment (e.g. search, Puppeteer for dynamic sites).

### Instructions
1. Identify the core components of the user's research topic.
2. Search the web using available tools to find high-quality resources.
3. Use reading tools to fetch content of the most promising 3-5 URLs.
4. Synthesize findings into a structured Markdown document (Executive Summary, Deep Dive, Pros/Cons, Citations).
5. Save the final report to the specified Research/ directory.
```
</details>

<details>
<summary><b>Implementer Agent</b> (Task Execution)</summary>

The primary agent responsible for writing code and tests in the TDD loop.

```markdown
You are an expert TDD implementer working in a sandboxed git branch.
Your objective is to implement a feature or fix a bug following strict Test-Driven Development (TDD) principles.

## Context Mode (MANDATORY)
Default to context-mode for ALL commands. Only use Bash for guaranteed-small-output operations (mkdir, git add, cd).
**Everything else → \`ctx_execute\` or \`ctx_execute_file\`.**

### Your Workflow
1. **Understand**: Use \`read\` or \`ctx_execute_file\` to grasp the current implementation. **Always check \`.tdd-workflow/analysis/\` if it exists.**
2. **Test First**: Create or update test files using \`write\` or \`edit\`.
3. **Verify Failure**: Run tests via \`ctx_execute\` to confirm they fail (red).
4. **Implement**: Write the minimal code needed to make the tests pass.
5. **Verify Success**: Run tests again using \`ctx_execute\`.
6. **Refactor**: Clean up and ensure all tests continue to pass.
```
</details>

<details>
<summary><b>Reviewer Agent</b> (Quality Gate)</summary>

An adversarial agent that attempts to find flaws in the Implementer's work.

```markdown
You are a skeptical senior software engineer performing a hostile code review.
Your DEFAULT position is REJECTION. Your goal is to find edge cases, security flaws, and missing tests.

## Context Mode (MANDATORY)
Default to context-mode for ALL commands.
**Everything else → \`ctx_execute\` or \`ctx_execute_file\`.**

### Your Process
1. Inspect the implementation and its tests using \`read\` or \`ctx_execute_file\`. **Check \`.tdd-workflow/analysis/\` to ensure alignment.**
2. **Note**: The orchestrator has already confirmed that the tests pass and code coverage requirements are met. Your focus is on logic, security, and architectural integrity.
3. Check for proper error handling, security vulnerabilities, and missing edge-case tests.
```
</details>

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LLAMA_CPP_URL` | `http://localhost:8080/v1` | llama.cpp server URL |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG search URL |
| `OPENROUTER_API_KEY` | — | API key for OpenRouter models |
| `OPENAI_API_KEY` | — | API key for OpenAI models |
| `TDD_WORKFLOW_CONFIG_DIR` | — | Override config file search directory |
| `LENS_FAIL_POLICY` | `fail-closed` | Controls Lens gate crash behaviour. `fail-open` skips the gate on crash (use on dev machines without Lens); `fail-closed` (default) treats a crash as a gate failure (safe for CI). |
| `TDD_SLOT_RECOVERY_MS` | `5000` | Milliseconds to wait after sub-agent session disposal before reusing the slot. Lower this on fast machines to speed up parallel execution. |

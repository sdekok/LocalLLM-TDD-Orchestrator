# Epic: Agentic TDD Workflow Orchestrator

## Overview
As a developer using local LLMs alongside the Pi Coding Agent, I want a robust, non-AI based orchestrator to manage my test-driven-development cycles so that I can automatically transition raw requirements into vetted, test-passing features without manually prompting the AI at every step or blowing out my context window limits.

## Story 1: Intelligent Planning and Breakdown
**As a** workflow orchestrator,
**I need** to feed the raw user requirement into a Planner Agent connected to local LLMs (llama.cpp)
**So that** the request can be rigorously evaluated, refined, and chunked into small, testable vertical slices that fit the TDD mold.

**Acceptance Criteria:**
1. The planner receives the raw user request and returns structured JSON defining a `refinedRequest` and an array of `subtasks`.
2. Each subtask must map exactly to a testable feature slice.
3. These tasks are saved to the orchestrator’s persistent state schema.

## Story 2: The TDD Implementation Loop
**As a** TDD implementation persona,
**I need** to take an isolated subtask and autonomously write edge-case tests, run them, and build the source code
**So that** only well-structured, passing code is ever considered complete.

**Acceptance Criteria:**
1. The implementer parses the current active task.
2. The agent outputs test files followed by source implementation files.
3. The orchestrator executes the test runner dynamically within the project directory.
4. Pass/Fail terminal outputs (`stdout`/`stderr`) are captured for immediate downstream review.

## Story 3: Independent Peer Review
**As a** Reviewer persona,
**I need** to run in a completely fresh context window, detached from the implementer's biases,
**So that** I can objectively grade the quality of the tests, code, and pass/fail execution logs against high standards.

**Acceptance Criteria:**
1. Tests, implementation files, and script outputs are submitted to the Reviewer.
2. Evaluates via structured JSON returning a boolean `approved` status and a string of `feedback`.
3. If rejected, the orchestrator routes the feedback directly back to the Implementer and increments the attempt counter.
4. Work terminates early after 3 failed implementation cycles.

## Story 4: Persistent State Management
**As a** local developer,
**I need** my workflow state to persist gracefully outside of my RAM
**So that** if the Docker LLM hangs, my PC reboots, or I want to resume work later, the agent picks up exactly where it left off.

**Acceptance Criteria:**
1. The orchestrator maintains a `workflow-state.json` artifact at the project root.
2. Contains checkpoints for `pending`, `in_progress`, `completed`, and `failed` tasks.
3. Automatically hydrates memory from this JSON block on startup before executing pending lists.

## Story 5: MCP Ecosystem Integration
**As a** Pi Agent user,
**I need** this orchestrator exposed inside my Pi workspace natively via the Model Context Protocol (MCP) and to integrate deeply with my existing MCP ecosystem.
**So that** I can trigger automated loops contextually from within a standard chat sequence, feed indexed repo memory (`ctx_search`) to the sub-agents seamlessly, and track their downstream execution (`ctx_index`).

**Acceptance Criteria:**
1. Exposes an MCP server wrapper.
2. Publishes the `start_tdd_workflow`, `resume_tdd_workflow`, `check_workflow_status`, and `analyze_project` tools to the host.
3. Functions asynchronously so Pi’s chat window is never blocked while the orchestrator works in the background.
4. Automatically discovers and acts as an *MCP client* to registered third-party servers, actively requesting knowledge via `context-mode` and reporting workflow events back to its proxy.

## Story 6: Multi-Language Code Analysis
**As a** developer working in polyglot codebases,
**I need** the orchestrator to deeply understand my project's architecture regardless of whether it's TypeScript, C#, or C++,
**So that** the planner and implementer can reason about dependency graphs, module boundaries, and design patterns using native AST-level information instead of shallow text search.

**Acceptance Criteria:**
1. The `AnalyzerRegistry` auto-detects the project language by presence of marker files (`tsconfig.json`, `*.csproj`, `CMakeLists.txt`).
2. **TypeScript** analysis uses `ts-morph` for full dependency graph, export maps, and type information.
3. **C#** analysis uses a Roslyn sidecar CLI (`Microsoft.CodeAnalysis.CSharp`) to parse namespaces, class hierarchies, `using` directives, and detect test frameworks (`[Fact]`/`[Test]`).
4. **C++** analysis uses native `tree-sitter` bindings to extract `#include` graphs (distinguishing `<system>` from `"local"`), class/struct/enum definitions, function signatures, and detect common patterns (Abstract Class, Singleton).
5. Analysis results conform to the shared `AnalysisResult` schema and are cached in `.tdd-workflow/analysis/`.
6. Cached analysis is fed into the context gatherer to enrich the planner and implementer prompts.

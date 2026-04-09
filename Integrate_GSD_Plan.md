# TDD Workflow Extension for gsd-pi: Migration & Integration Plan

## Context

The TDD Agentic Workflow project (`tdd-agentic-workflow`) is already structured as a Pi SDK extension (`src/interfaces/pi/index.ts`, deployed via `npm run deploylocal` to `~/.pi/extensions/tdd-workflow`). The goal is to make it a first-class extension for **gsd-pi** (gsd-2), leveraging GSD's superior orchestration (wave execution, git worktrees, disk state machine, crash recovery, parallel coordination) while contributing TDD workflow, small-model optimization, code analysis, and adversarial review capabilities that GSD lacks.

**Key insight**: This is NOT a rewrite. The existing extension entry point, commands (`/tdd`, `/plan`, `/analyze`, `/research`), and internal modules already work. The migration is about:
1. Ensuring compatibility with gsd-2's vendored Pi SDK (`@gsd/pi-coding-agent` vs `@mariozechner/pi-coding-agent`)
2. Adding hooks that integrate with GSD's auto-mode phases
3. Gradually replacing custom orchestration with GSD's infrastructure
4. Contributing small-model support that GSD doesn't have

## Packaging: Standalone Extension

Stays as a standalone npm package deployed to `~/.pi/extensions/tdd-workflow` (or `~/.gsd/agent/extensions/tdd-workflow`). Reasoning:
- Already works this way (`deploylocal` script)
- Heavy native deps (ts-morph, tree-sitter, .NET Roslyn) shouldn't bloat GSD core
- Independent release cycle from GSD
- Opt-in for users who don't need TDD workflow

## Phase 1: SDK Compatibility + Smoke Test

**Goal**: Extension loads and commands work under gsd-2 (not just standalone Pi).

### Work
1. **Audit imports** — Check if gsd-2 re-exports Pi SDK types under `@gsd/` scope or keeps `@mariozechner/`. If different, add a compatibility shim or update imports.
2. **Install gsd-2 locally** — Pull the container or clone the repo, verify the extension loads.
3. **Test existing commands** — `/tdd`, `/plan`, `/analyze`, `/research` should work as-is since they use standard `ExtensionAPI` hooks.
4. **Fix any breaking differences** — GSD-2 may have newer extension API surface; resolve type mismatches.

### Files
- `package.json` — Update peer dependency if needed
- `src/interfaces/pi/index.ts` — Adjust imports if GSD uses different package scope

### Validation
- Run `gsd` with extension symlinked, type `/tdd`, `/plan`, `/analyze`, `/status` — all should respond.

---

## Phase 2: Model Tuning Hooks for GSD Sessions

**Goal**: When GSD spawns agents (in auto-mode or interactive), local model tuning is applied.

### Work
1. **Register llama-cpp provider** — Use `pi.registerProvider("llama-cpp", ...)` in `session_start` hook so local models appear in GSD's model selector.
2. **`before_provider_request` hook** — Intercept LLM requests and inject vendor-recommended sampling params (Gemma 4: top_k=64, top_p=0.95, temp=0.8; Qwen 3.5: top_k=20, etc.) based on detected model family.
3. **`context` hook** — Apply Gemma 4 thinking-block filter (`stripThinkingFromHistory`) for ALL GSD sessions using Gemma 4, not just TDD sub-agents.
4. **`before_agent_start` hook** — Inject model-specific prompt tweaks (e.g., `<|think|>` prefix for Gemma 4 thinking mode).

### Files
- `src/interfaces/pi/index.ts` — Add new hook registrations
- `src/llm/tuners/gemma4.ts`, `qwen35.ts` — Already exist, wire into hooks
- `src/subagent/factory.ts` — Extract provider registration logic

### Validation
- Start GSD with Gemma 4 via llama.cpp. Check server logs show `top_k=64`.
- Start multi-turn session, verify thinking blocks stripped from history.
- Switch to Qwen 3.5, verify `top_k=20`.

---

## Phase 3: Quality Gates as GSD Verification Extension

**Goal**: GSD's verification phase uses the full quality gate pipeline instead of just lint+test.

### Work
1. **Register `tdd_quality_gates` tool** — Exposes the gate pipeline (lens, tsc, tests, coverage, lint, file-safety) as an LLM-callable tool that GSD agents can invoke during verification.
2. **Add `verification_commands` config** — Document how users configure GSD's `.gsd/config` to use TDD gates: `verification_commands: ["pi tool tdd_quality_gates"]` (or however GSD invokes registered tools as shell commands).
3. **`tool_result` hook on bash** — When GSD's executor runs tests via bash, intercept results and feed into TDD state tracking (pass/fail/coverage metrics).
4. **LENS_FAIL_POLICY** — Preserve env-var-based policy (fail-closed in CI, fail-open in dev).

### Files
- `src/interfaces/pi/index.ts` — Add `pi.registerTool()` for quality gates
- `src/orchestrator/quality-gates.ts` — Already exists, wrap as tool handler
- `src/orchestrator/test-runner.ts` — Already exists, used by quality gates

### Validation
- GSD auto-mode runs with TDD extension. After implementation, quality gates run automatically.
- Lens failure blocks progress (fail-closed). Coverage below threshold blocks.

---

## Phase 4: TDD Workflow as GSD Execution Phase

**Goal**: The red-green-refactor cycle integrates with GSD's plan→execute→verify flow.

### Work
1. **TDD skill definition** (`skills/tdd-implement/SKILL.md`) — The IMPLEMENTER_PROMPT reformatted as a Pi skill. When GSD dispatches a task tagged as TDD, this skill drives the agent.
2. **Review skill** (`skills/tdd-review/SKILL.md`) — The REVIEWER_PROMPT as a skill.
3. **`resources_discover` hook** — Register skill directory so GSD discovers TDD skills.
4. **`before_agent_start` hook** — When TDD workflow is active, inject task metadata (acceptance criteria, security, tests, devNotes) into the system prompt.
5. **Hybrid execution**: For tight TDD inner loops, spawn in-memory sub-agent sessions via `createSubAgentSession`. For orchestration-level work, let GSD's subprocess model handle it.
6. **VRAM semaphore** — Enforce max-2-parallel via semaphore in the executor to prevent VRAM oversubscription when GSD runs parallel worktree tasks.

### Files
- `skills/tdd-implement/SKILL.md` — New, derived from `IMPLEMENTER_PROMPT`
- `skills/tdd-review/SKILL.md` — New, derived from `REVIEWER_PROMPT`
- `src/interfaces/pi/index.ts` — Add `resources_discover` hook
- `src/orchestrator/executor.ts` — Add semaphore, integrate with GSD parallel coordination

### Validation
- Run `/tdd "Add user auth"` under GSD. Observe: planner decomposes → implementer writes tests (red) → implements (green) → quality gates pass → reviewer approves → merge.
- Run with 2 parallel tasks, verify VRAM semaphore prevents oversubscription.

---

## Phase 5: GSD Auto-Mode Deep Integration

**Goal**: GSD's fully autonomous mode (`gsd auto`) leverages TDD workflow when configured.

### Work
1. **TDD configuration** — Add `.gsd/tdd.config.json` or extend GSD's config to enable TDD mode per project. When enabled, GSD's planner includes TDD subtask decomposition.
2. **Wave-aware TDD** — When GSD computes execution waves, TDD tasks respect the constraint: test scaffolds in Wave 0, implementations in Wave 1 (2 parallel), integration in Wave 2.
3. **Git worktree integration** — Each parallel TDD executor gets its own worktree via GSD's worktree manager instead of the custom `Sandbox` class.
4. **Disk-based state** — Migrate from `StateManager` (in-memory + file) to GSD's `.gsd/STATE.md` pattern for TDD state, enabling crash recovery.
5. **Stall detection** — Layer issue-count-decreasing check on top of existing `outputSimilarity` loop detection.

### Files
- `src/orchestrator/state.ts` — Adapt to write TDD state into `.gsd/` directory
- `src/orchestrator/sandbox.ts` — Optionally delegate to GSD's worktree manager
- `src/orchestrator/executor.ts` — Integrate stall detection

### Validation
- `gsd auto` on a TDD-configured project runs the full lifecycle autonomously.
- Kill the process mid-task, restart — state recovers from `.gsd/`.
- Two parallel TDD tasks run in separate worktrees without conflict.

---

## What Can Be Reused As-Is (No Changes)

| Module | Path | Notes |
|--------|------|-------|
| Code analyzers | `src/analysis/typescript-analyzer.ts`, `csharp-analyzer.ts`, `cpp-analyzer.ts` | Pure analysis, no Pi dependency |
| Model tuners | `src/llm/tuners/gemma4.ts`, `qwen35.ts`, `generic.ts` | Already clean, just need hook wiring |
| Thinking filter | `src/subagent/factory.ts` (`stripThinkingFromHistory`) | Already exported and tested |
| Quality gate pipeline | `src/orchestrator/quality-gates.ts` | Wrap as registered tool |
| System prompts | `src/subagent/prompts.ts` | Convert to skills (.md) |
| Path safety | `src/utils/path-safety.ts` | Pure utility |
| URL validator | `src/utils/url-validator.ts` | Pure utility |
| Sub-agent factory | `src/subagent/factory.ts` | Core of hybrid execution model |
| Response extractor | `src/agents/components/response-extractor.ts` | Pure JSON parsing |

## What Gets Replaced by GSD Infrastructure (Eventually)

| Current Module | GSD Replacement | Phase |
|---------------|-----------------|-------|
| `StateManager` (in-memory + file) | `.gsd/STATE.md` disk state machine | Phase 5 |
| `Sandbox` (custom git branch) | GSD worktree manager | Phase 5 |
| Custom orchestration loop | GSD auto-mode with TDD hooks | Phase 5 |
| Sequential task execution | GSD wave-based parallel execution | Phase 5 |

## Verification (End-to-End)

After all phases:
1. `gsd` loads with TDD extension — `/tdd`, `/plan`, `/analyze`, `/research` all work
2. Local models (Gemma 4, Qwen 3.5) selectable with correct sampling params
3. Quality gates run as GSD verification step
4. TDD cycle (red-green-refactor) drives implementation tasks
5. `gsd auto` with TDD config runs fully autonomously
6. Max 2 parallel agents enforced
7. All existing tests pass (`npm test` — 313 tests)

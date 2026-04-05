# Agent Rules (Pi Native)

1. **Language**: All code should be in TypeScript by default.
2. **Programming Paradigm**: Use functional patterns over object-oriented ones, except for domain models.
3. **Testing**: Use Test-Driven Development (TDD) wherever possible. Ensure edge cases are covered and run tests during each iteration.
4. **Workflow & Context Management**:
    - Work in small chunks.
    - For each task, the orchestrator spawns **ephemeral sub-agent sessions**.
    - These agents use native Pi tools (`read`, `edit`, `write`, `bash`) for direct filesystem interaction.
    - **Self-Healing**: If quality gates fail, feedback is injected into the next session prompt.
5. **Context & Analysis**:
    - **Analysis Integration**: Always incorporate documentation and findings from the `.tdd-workflow/analysis` directory into planning. This directory contains the "ground truth" produced by the `/analyze` command.
    - **Native Context**: Utilize Pi's built-in context discovery and memory indexing where available.

## Agent Roles

| Role | Purpose |
|---|---|
| **Architect** | Strategic agent used for high-level project planning (via `/plan`). Decomposes requests into Epics and WorkItems in `WorkItems/`. |
| **Planner** | Refines high-level work items into technical subtasks during execution. |
| **Implementer** | Native sub-session that writes tests and code to pass them for a specific work item. |
| **Reviewer** | Adversarial sub-session that scores code on quality, security, and coverage. |
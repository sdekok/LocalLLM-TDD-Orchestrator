# Agent Rules

1. **Language**: All code should be in TypeScript by default.
2. **Programming Paradigm**: Use functional patterns over object-oriented ones, except for domain models.
3. **Testing**: Use Test-Driven Development (TDD) wherever possible. Ensure edge cases are covered and run tests during each iteration.
4. **Workflow & Context Management**:
    - Work in small chunks.
    - Maintain requirements and specifications using one file per epic in the `specs/` folder.
    - Maintain a `list.md` file containing all outstanding high-level tasks. Remove completed items as they are finished.
    - For each high-level task, break it down into subtasks in a `subtasks.md` file, maintaining it in a similar way to `list.md`.
    - This approach is intended to limit the context required to complete any single task.
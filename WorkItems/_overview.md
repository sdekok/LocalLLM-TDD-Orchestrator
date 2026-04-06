# Project Overview

Implement a robust GitHub Actions CI/CD pipeline for the TDD Agentic Workflow project. The pipeline will handle multi-language requirements (Node.js and .NET) to ensure the core orchestrator and its C# analysis tools are both built and verified on every push and pull request.

## Architectural Decisions

- Use a single monolithic CI workflow for simplicity as the project size is currently manageable.
- Target Ubuntu-latest as the standard runner to match local development environments.
- Strictly follow the existing `package.json` scripts to ensure the CI environment exactly matches the developer's local build/test process.
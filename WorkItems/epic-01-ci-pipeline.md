# Epic: CI Pipeline Implementation

## Summary
Establish a automated continuous integration workflow that mirrors the local build and test process.

## Security Strategy
Use minimal permissions for the GITHUB_TOKEN. Ensure no secrets are hardcoded in the YAML. Use official, versioned actions from GitHub to prevent supply chain attacks.

## Testing Strategy
Verify the workflow by simulating a failure (e.g., a failing test or a broken build command) and ensuring the CI job fails accordingly.

## Work Items

### CI-01: Create Core CI Workflow

**Description**: Create `.github/workflows/ci.yml` which includes: setup of Node.js (v20), setup of .NET (v10), dependency installation via `npm ci`, building the C# analyzer, building the main project via `npm run build`, and running tests via `npm test`.

**Acceptance Criteria**:
- Workflow file exists in `.github/workflows/ci.yml`
- Workflow triggers on 'push' and 'pull_request' to 'main'
- Workflow successfully executes 'npm run build' which includes the C# build step
- Workflow successfully executes 'npm test'

**Security Considerations**: Use specific action versions (e.g., `actions/checkout@v4`) to ensure stability and security.

**Recommended Tests**:
- Given a push to main, When the workflow runs, Then all build and test steps should pass.

**Developer Notes**: The build command is complex: `dotnet build ... && tsc && npm run bundle ...`. Ensure the environment has both Node and .NET installed. The project uses `vitest` for testing.

---

### CI-02: Add Dependency Caching

**Description**: Optimize workflow speed by implementing caching for `node_modules` and .NET NuGet packages.

**Acceptance Criteria**:
- Workflow uses `actions/setup-node@v4` with `cache: 'npm'`
- Workflow uses `actions/setup-dotnet@v4` with caching enabled (if possible/supported for the specific version)
- Subsequent runs show 'Cache restored' in logs

**Security Considerations**: N/A

**Recommended Tests**:
- Given a second run of the workflow, When dependencies are unchanged, Then the cache should be utilized.

**Developer Notes**: Caching reduces runner time significantly, especially given the size of `node_modules` seen in the project structure.

---


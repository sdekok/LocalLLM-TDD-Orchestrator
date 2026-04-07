# Epic: Automated Publishing for Pi Install

## Summary
Enable automated publishing of the package so that it can be consumed by the `pi install` command.

## Security Strategy
Strictly control publishing rights via GitHub Environments and protected secrets. Use `provenance: true` for NPM if applicable to ensure supply chain security.

## Testing Strategy
Verify the published package by performing a `pi install` from a clean environment or by inspecting the published registry content.

## Work Items

### PUB-01: Configure Publishing Workflow

**Description**: Create `.github/workflows/publish.yml` that triggers on `push` to `main` or when a new release is created. This workflow should build the project and publish it to the target registry (NPM or GitHub Packages).

**Acceptance Criteria**:
- Workflow triggers on release.
- The package is successfully uploaded to the registry.
- The package version in `package.json` matches the published version.

**Security Considerations**: Use `secrets.NPM_TOKEN` or equivalent for authentication.

**Recommended Tests**:
- Given a new tag, when the workflow runs, then the package should be available in the registry.

**Developer Notes**: The `build` script already handles the complex `dotnet` and `esbuild` steps; ensure the publishing workflow calls this correctly.

---

### PUB-02: Verify 'pi install' Compatibility

**Description**: Ensure the published package structure is compatible with `pi install`. This includes verifying that the `pi.extensions` field in `package.json` correctly points to the distributed files in the `dist/` folder.

**Acceptance Criteria**:
- The published `dist/interfaces/pi` contains the necessary files for the extension to function.
- A user can run `pi install <package-name>` and have the extension correctly registered.

**Security Considerations**: N/A

**Recommended Tests**:
- Given the published package, when running `pi install`, then the extension should be added to the Pi configuration.

**Developer Notes**: Pay close attention to the `bundle` step in the `build` script; ensure the bundle is included in the published package.

---


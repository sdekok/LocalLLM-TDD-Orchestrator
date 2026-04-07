# Project Overview

Implement a CI/CD pipeline using GitHub Actions to automate testing and code coverage reporting on pull requests. Additionally, set up an automated publishing workflow to release the package (to NPM or GitHub Packages) so it can be easily installed using the `pi install` command.

## Architectural Decisions

- Use GitHub Actions for all CI/CD orchestration.
- Use Vitest with the `v8` coverage provider for high-performance coverage measurement.
- Target NPM (or GitHub Packages) as the primary distribution mechanism to satisfy `pi install` requirements.
- Automated publishing will be tied to Git Tags/Releases to prevent accidental production releases.
# Changelog

All notable changes to tdd-workflow are noted here, newest first. Versions are
bumped per feature batch; the running plugin stamps its version + git sha at load
(see `/tdd:status`).

## 2.1.0

- **Version-stamped builds.** The bundle now embeds `{version, gitSha, builtAt}`
  (via esbuild `--define` in `scripts/bundle.mjs`). Logged at extension load and
  shown in `/tdd:status` so it's obvious whether a running Pi session is on the
  build you just deployed.
- **Persisted attempt ceiling.** `Subtask` now records `attemptCeiling` and
  `arbiterRounds`, so a task interrupted after the arbiter granted extra rounds
  resumes with the correct loop bounds instead of falling into a blind arbiter
  consult.
- **Config validation.** `models.config.json` is validated with zod at load; an
  unknown routing target or malformed profile produces a precise message and
  falls back to passthrough mode instead of silently using defaults.
- **Test harness.** Extracted the WorkflowExecutor streaming-test scaffolding
  into `tests/helpers/` and added a resume-matrix suite covering status × phase ×
  resume-mode × attempts.

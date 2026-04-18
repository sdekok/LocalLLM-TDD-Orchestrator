# CLAUDE.md — Claude Code guidance for tdd-pi-plugin

## Before every commit or push

Always run both of these commands and fix any failures before committing or pushing:

```bash
npm run build   # TypeScript compile + bundle
npx vitest run  # Full test suite
```

Never commit or push with a failing build or failing tests.

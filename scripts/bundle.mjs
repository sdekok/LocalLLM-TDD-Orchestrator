/**
 * Bundles the compiled extension entrypoint and stamps build metadata into it.
 *
 * Replaces the old inline `esbuild ... && mv` one-liner so we can inject
 * version / git sha / build timestamp via `--define`. Those three values surface
 * at runtime through src/version.ts (logged at extension load and shown in
 * /tdd:status), which is what tells you whether a running Pi session is actually
 * on the build you just deployed.
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, renameSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

function git(args, fallback) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

const shortSha = git('rev-parse --short HEAD', 'unknown');
const dirty = git('status --porcelain', '') !== '';
const gitSha = dirty ? `${shortSha}-dirty` : shortSha;
const builtAt = new Date().toISOString();

const ENTRY = 'dist/interfaces/pi/index.js';
const TMP = 'dist/interfaces/pi/index.bundle.js';

await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: TMP,
  external: [
    'tree-sitter',
    'tree-sitter-cpp',
    'jsdom',
    '@earendil-works/pi-coding-agent',
    'pi-lens',
    'ts-morph',
  ],
  define: {
    __TDD_VERSION__: JSON.stringify(pkg.version),
    __TDD_GIT_SHA__: JSON.stringify(gitSha),
    __TDD_BUILT_AT__: JSON.stringify(builtAt),
  },
});

renameSync(TMP, ENTRY);
console.log(`Bundled ${pkg.name} ${pkg.version} (${gitSha}, built ${builtAt})`);

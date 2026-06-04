import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isNxWorkspace,
  getBuildCommand,
  getLintCommand,
} from '../../src/orchestrator/test-runner.js';

let dir: string;

function write(rel: string, content: string) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function pkg(obj: unknown) {
  write('package.json', JSON.stringify(obj));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-resolver-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isNxWorkspace', () => {
  it('detects nx.json in the project dir', () => {
    pkg({ name: 'x' });
    write('nx.json', '{}');
    expect(isNxWorkspace(dir)).toBe(true);
  });

  it('detects nx.json in an ancestor dir', () => {
    write('nx.json', '{}');
    const sub = path.join(dir, 'libs', 'feature');
    fs.mkdirSync(sub, { recursive: true });
    expect(isNxWorkspace(sub)).toBe(true);
  });

  it('returns false with no nx.json', () => {
    pkg({ name: 'x' });
    expect(isNxWorkspace(dir)).toBe(false);
  });
});

describe('getBuildCommand', () => {
  it('prefers an explicit tddConfig.buildCommand', () => {
    pkg({ name: 'x', tddConfig: { buildCommand: 'make build' }, scripts: { build: 'tsc' } });
    expect(getBuildCommand(dir)).toBe('make build');
  });

  it('uses nx affected build inside an Nx workspace', () => {
    pkg({ name: 'x', scripts: { build: 'tsc' } });
    write('nx.json', '{}');
    expect(getBuildCommand(dir)).toBe('npx nx affected -t build');
  });

  it('uses nx run-many build at full scope (baseline)', () => {
    pkg({ name: 'x', scripts: { build: 'tsc' } });
    write('nx.json', '{}');
    expect(getBuildCommand(dir, true)).toBe('npx nx run-many -t build');
  });

  it('falls back to the package.json build script with the detected PM', () => {
    pkg({ name: 'x', scripts: { build: 'tsc -p tsconfig.build.json' } });
    write('pnpm-lock.yaml', '');
    expect(getBuildCommand(dir)).toBe('pnpm run build');
  });

  it('returns null when there is no build command', () => {
    pkg({ name: 'x', scripts: { test: 'vitest' } });
    expect(getBuildCommand(dir)).toBeNull();
  });
});

describe('getLintCommand', () => {
  it('prefers an explicit tddConfig.lintCommand', () => {
    pkg({ name: 'x', tddConfig: { lintCommand: 'biome check .' } });
    expect(getLintCommand(dir)).toBe('biome check .');
  });

  it('uses nx affected lint inside an Nx workspace', () => {
    pkg({ name: 'x' });
    write('nx.json', '{}');
    expect(getLintCommand(dir)).toBe('npx nx affected -t lint');
  });

  it('uses nx run-many lint at full scope (baseline)', () => {
    pkg({ name: 'x' });
    write('nx.json', '{}');
    expect(getLintCommand(dir, true)).toBe('npx nx run-many -t lint');
  });

  it('full scope still defers to an explicit tddConfig.lintCommand', () => {
    pkg({ name: 'x', tddConfig: { lintCommand: 'biome check .' } });
    write('nx.json', '{}');
    expect(getLintCommand(dir, true)).toBe('biome check .');
  });

  it('omits the dead --ext flag under flat config (eslint.config.mjs)', () => {
    pkg({ name: 'x' });
    write('eslint.config.mjs', 'export default [];');
    expect(getLintCommand(dir)).toBe('npx eslint . --max-warnings 0');
  });

  it('passes --ext only for legacy .eslintrc config', () => {
    pkg({ name: 'x' });
    write('.eslintrc.json', '{}');
    expect(getLintCommand(dir)).toBe('npx eslint . --ext .ts,.js --max-warnings 0');
  });

  it('prefers a package.json lint script over a bare eslint invocation', () => {
    pkg({ name: 'x', scripts: { lint: 'eslint src' } });
    write('eslint.config.mjs', 'export default [];');
    expect(getLintCommand(dir)).toBe('npm run lint');
  });

  it('returns null when no linter is configured', () => {
    pkg({ name: 'x' });
    expect(getLintCommand(dir)).toBeNull();
  });
});

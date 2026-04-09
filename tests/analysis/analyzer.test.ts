import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TypeScriptAnalyzer } from '../../src/analysis/typescript-analyzer.js';
import {
  AnalyzerRegistry,
  formatAnalysisForPrompt,
  formatMultiAnalysisForPrompt,
} from '../../src/analysis/types.js';
import { analyzeProject, loadCachedAnalysis, isAnalysisStale } from '../../src/analysis/runner.js';

describe('TypeScriptAnalyzer', () => {
  let projectDir: string;
  let analyzer: TypeScriptAnalyzer;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `ts-analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
    analyzer = new TypeScriptAnalyzer();

    // Create a mini TypeScript project
    fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', outDir: 'dist', strict: true },
      include: ['src'],
    }));

    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'test-project',
      main: 'dist/index.js',
    }));

    // Source files
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), [
      'export { UserService } from "./services/user-service.js";',
      'export { greet } from "./utils/helpers.js";',
    ].join('\n'));

    fs.mkdirSync(path.join(projectDir, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'services', 'user-service.ts'), [
      '/** Manages user CRUD operations */',
      'export class UserService {',
      '  private static instance: UserService;',
      '  static getInstance(): UserService {',
      '    if (!UserService.instance) UserService.instance = new UserService();',
      '    return UserService.instance;',
      '  }',
      '  async findUser(id: string): Promise<{ id: string; name: string }> {',
      '    return { id, name: "test" };',
      '  }',
      '}',
    ].join('\n'));

    fs.mkdirSync(path.join(projectDir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'utils', 'helpers.ts'), [
      '/** Greet a user by name */',
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`;',
      '}',
      '',
      'export const VERSION = "1.0.0";',
    ].join('\n'));

    // Test file (only for helpers)
    fs.writeFileSync(path.join(projectDir, 'tests', 'helpers.test.ts'), [
      'import { greet } from "../src/utils/helpers.js";',
      'console.log(greet("world"));',
    ].join('\n'));
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('detects TypeScript projects', async () => {
    expect(await analyzer.canAnalyze(projectDir)).toBe(true);
  });

  it('does not detect non-TS projects', async () => {
    const emptyDir = path.join(os.tmpdir(), `empty-${Date.now()}`);
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(await analyzer.canAnalyze(emptyDir)).toBe(false);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('analyzes exports', async () => {
    const result = await analyzer.analyze(projectDir);
    const helperModule = result.modules.find((m) => m.filepath.includes('helpers'));
    expect(helperModule).toBeDefined();
    expect(helperModule!.exports.length).toBeGreaterThanOrEqual(2);

    const greetExport = helperModule!.exports.find((e) => e.name === 'greet');
    expect(greetExport).toBeDefined();
    expect(greetExport!.kind).toBe('function');
    expect(greetExport!.signature).toContain('greet');
  });

  it('extracts imports', async () => {
    const result = await analyzer.analyze(projectDir);
    const indexModule = result.modules.find((m) => m.filepath.includes('index'));
    expect(indexModule).toBeDefined();
    expect(indexModule!.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('builds dependency graph', async () => {
    const result = await analyzer.analyze(projectDir);
    expect(result.dependencyGraph.length).toBeGreaterThan(0);
    // index.ts imports from services and utils
    const indexImports = result.dependencyGraph.filter((e) => e.from.includes('index'));
    expect(indexImports.length).toBeGreaterThanOrEqual(1);
  });

  it('detects Singleton pattern', async () => {
    const result = await analyzer.analyze(projectDir);
    const singletonPattern = result.patterns.find((p) => p.pattern === 'Singleton');
    expect(singletonPattern).toBeDefined();
    expect(singletonPattern!.filepath).toContain('user-service');
  });

  it('detects test coverage', async () => {
    const result = await analyzer.analyze(projectDir);
    expect(result.stats.filesWithTests).toBeGreaterThanOrEqual(0);
    expect(result.stats.filesWithoutTests).toBeGreaterThanOrEqual(1);
  });

  it('computes stats', async () => {
    const result = await analyzer.analyze(projectDir);
    expect(result.stats.totalFiles).toBeGreaterThanOrEqual(3);
    expect(result.stats.totalExports).toBeGreaterThanOrEqual(3);
  });

  it('respects maxFiles option', async () => {
    const result = await analyzer.analyze(projectDir, { maxFiles: 1 });
    expect(result.modules.length).toBe(1);
  });

  it('finds entry points', async () => {
    const result = await analyzer.analyze(projectDir);
    expect(result.entryPoints).toContain('dist/index.js');
  });
});

describe('AnalyzerRegistry', () => {
  it('registers and detects analyzers', async () => {
    const registry = new AnalyzerRegistry();
    registry.register(new TypeScriptAnalyzer());

    const listed = registry.listAnalyzers();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.languages).toContain('typescript');
  });
});

describe('formatAnalysisForPrompt', () => {
  it('produces readable output', () => {
    const result = {
      language: 'typescript',
      projectRoot: '/tmp/test',
      analyzedAt: new Date().toISOString(),
      modules: [
        {
          filepath: 'src/index.ts',
          exports: [{ name: 'main', kind: 'function' as const, filepath: 'src/index.ts', line: 1, signature: 'function main()', isExported: true }],
          imports: [],
          linesOfCode: 10,
          hasTests: false,
        },
      ],
      dependencyGraph: [],
      patterns: [{ pattern: 'Singleton', filepath: 'src/service.ts', evidence: 'getInstance()' }],
      entryPoints: ['src/index.ts'],
      circularDependencies: [],
      stats: { totalFiles: 1, totalExports: 1, totalImports: 0, filesWithTests: 0, filesWithoutTests: 1 },
    };

    const prompt = formatAnalysisForPrompt(result);
    expect(prompt).toContain('Code Analysis');
    expect(prompt).toContain('1 files');
    expect(prompt).toContain('Singleton');
    expect(prompt).toContain('without tests');
  });

  it('handles multiple analyses', () => {
    const results = [
      {
        language: 'typescript',
        projectRoot: '/tmp/test',
        analyzedAt: new Date().toISOString(),
        modules: [],
        dependencyGraph: [],
        patterns: [],
        entryPoints: [],
        circularDependencies: [],
        stats: { totalFiles: 5, totalExports: 10, totalImports: 8, filesWithTests: 3, filesWithoutTests: 2 },
      },
    ];
    const prompt = formatMultiAnalysisForPrompt(results);
    expect(prompt).toContain('typescript');
    expect(prompt).toContain('5 files');
  });
});

describe('Analysis persistence', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `analysis-persist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const x = 1;');
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('saves and loads analysis results', async () => {
    await analyzeProject(projectDir);

    const cached = loadCachedAnalysis(projectDir);
    expect(cached).not.toBeNull();
    expect(cached!.length).toBeGreaterThanOrEqual(1);
    expect(cached![0]!.language).toBe('typescript');
  });

  it('detects stale analysis', async () => {
    // No analysis yet — should be stale
    expect(isAnalysisStale(projectDir)).toBe(true);

    // Run analysis
    await analyzeProject(projectDir);
    expect(isAnalysisStale(projectDir)).toBe(false);

    // Modify a source file
    await new Promise((r) => setTimeout(r, 50)); // Ensure mtime changes
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const y = 2;');
    expect(isAnalysisStale(projectDir)).toBe(true);
  });

  it('returns null when no cache exists', () => {
    expect(loadCachedAnalysis(projectDir)).toBeNull();
  });
});

describe('TypeScriptAnalyzer — cycle detection DFS', () => {
  let projectDir: string;
  let analyzer: TypeScriptAnalyzer;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `ts-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    analyzer = new TypeScriptAnalyzer();

    fs.writeFileSync(path.join(projectDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
      include: ['src'],
    }));
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'cycle-test', main: 'src/a.ts' }));
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('detects a direct circular dependency (A -> B -> A)', async () => {
    // Use .ts specifiers so the resolved paths match the source file relPaths
    // (the analyzer keeps extension from import specifier in the `to` field)
    fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), [
      'import { b } from "./b.ts";',
      'export const a = "a";',
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, 'src', 'b.ts'), [
      'import { a } from "./a.ts";',
      'export const b = "b";',
    ].join('\n'));

    const result = await analyzer.analyze(projectDir);
    expect(result.circularDependencies.length).toBeGreaterThan(0);
  });

  it('reports no cycles for acyclic imports', async () => {
    // A imports B, no cycle
    fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), [
      'import { b } from "./b.ts";',
      'export const a = b + "a";',
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, 'src', 'b.ts'), [
      'export const b = "b";',
    ].join('\n'));

    const result = await analyzer.analyze(projectDir);
    expect(result.circularDependencies).toHaveLength(0);
  });
});

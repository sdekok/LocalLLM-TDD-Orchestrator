import { Project, SyntaxKind, type SourceFile, type Node } from 'ts-morph';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import type {
  CodeAnalyzer,
  AnalyzeOptions,
  AnalysisResult,
  ModuleSummary,
  ExportedSymbol,
  ImportEdge,
  PatternMatch,
} from './types.js';

/**
 * TypeScript/JavaScript analyzer using ts-morph (TypeScript Compiler API wrapper).
 * Extracts exports, imports, dependency graph, patterns, and circular dependencies.
 */
export class TypeScriptAnalyzer implements CodeAnalyzer {
  readonly name = 'TypeScript Analyzer';
  readonly languages = ['typescript', 'javascript'];

  async canAnalyze(projectDir: string): Promise<boolean> {
    // Has tsconfig.json OR has .ts/.js files in src/
    if (fs.existsSync(path.join(projectDir, 'tsconfig.json'))) return true;
    if (fs.existsSync(path.join(projectDir, 'jsconfig.json'))) return true;
    if (fs.existsSync(path.join(projectDir, 'package.json'))) {
      // Check if it's a JS/TS project
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
        const scripts = JSON.stringify(pkg.scripts || {});
        return scripts.includes('tsc') || scripts.includes('ts-') || scripts.includes('node');
      } catch {
        return false;
      }
    }
    return false;
  }

  async analyze(projectDir: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
    const logger = getLogger();
    logger.info(`TypeScript analysis starting: ${projectDir}`);

    const tsconfigPath = path.join(projectDir, 'tsconfig.json');
    const project = fs.existsSync(tsconfigPath)
      ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: false })
      : new Project();

    // If no tsconfig, add source files manually
    if (!fs.existsSync(tsconfigPath)) {
      const srcDir = path.join(projectDir, 'src');
      if (fs.existsSync(srcDir)) {
        project.addSourceFilesAtPaths(path.join(srcDir, '**/*.{ts,js,tsx,jsx}'));
      } else {
        project.addSourceFilesAtPaths(path.join(projectDir, '**/*.{ts,js,tsx,jsx}'));
      }
    }

    let sourceFiles = project.getSourceFiles().filter((sf) => {
      const fp = sf.getFilePath();
      return !fp.includes('node_modules') && !fp.includes('dist/') && !fp.includes('.tdd-workflow');
    });

    // Apply options
    if (options?.maxFiles && sourceFiles.length > options.maxFiles) {
      sourceFiles = sourceFiles.slice(0, options.maxFiles);
    }

    if (options?.exclude) {
      sourceFiles = sourceFiles.filter((sf) => {
        const fp = sf.getFilePath();
        return !options.exclude!.some((pattern) => fp.includes(pattern));
      });
    }

    const modules: ModuleSummary[] = [];
    const allImports: ImportEdge[] = [];
    const patterns: PatternMatch[] = [];

    const lensIndex = this.loadLensIndex(projectDir);
    if (lensIndex) {
      logger.info(`Loaded pi-lens index with ${lensIndex.entries.length} entries`);
    }

    for (const sourceFile of sourceFiles) {
      const relPath = path.relative(projectDir, sourceFile.getFilePath());
      const exports = this.extractExports(sourceFile, relPath, lensIndex);
      const imports = this.extractImports(sourceFile, relPath, projectDir);
      const detected = this.detectPatterns(sourceFile, relPath);

      const testFile = this.findTestFile(projectDir, relPath);

      modules.push({
        filepath: relPath,
        exports,
        imports,
        linesOfCode: sourceFile.getEndLineNumber(),
        hasTests: testFile !== null,
        testFilepath: testFile || undefined,
      });

      allImports.push(...imports);
      patterns.push(...detected);
    }

    const circularDeps = this.findCircularDependencies(allImports);
    const entryPoints = this.findEntryPoints(projectDir, modules);

    const result: AnalysisResult = {
      language: 'typescript',
      projectRoot: projectDir,
      analyzedAt: new Date().toISOString(),
      modules,
      dependencyGraph: allImports,
      patterns,
      entryPoints,
      circularDependencies: circularDeps,
      stats: {
        totalFiles: modules.length,
        totalExports: modules.reduce((sum, m) => sum + m.exports.length, 0),
        totalImports: allImports.length,
        filesWithTests: modules.filter((m) => m.hasTests).length,
        filesWithoutTests: modules.filter((m) => !m.hasTests).length,
      },
    };

    logger.info(
      `TypeScript analysis complete (Lens-enriched): ${result.stats.totalFiles} files, ` +
      `${result.stats.totalExports} exports, ${circularDeps.length} circular deps`
    );

    return result;
  }

  private loadLensIndex(projectDir: string): any {
    const indexPath = path.join(projectDir, '.pi-lens', 'index.json');
    if (!fs.existsSync(indexPath)) return null;

    try {
      const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      // Convert entries array back to a lookup map for faster access
      const entriesMap = new Map<string, any>();
      for (const [id, entry] of data.entries) {
        entriesMap.set(id, entry);
      }
      return { ...data, entriesMap };
    } catch (err) {
      getLogger().warn(`Failed to parse pi-lens index: ${err}`);
      return null;
    }
  }

  private extractExports(sourceFile: SourceFile, relPath: string, lensIndex?: any): ExportedSymbol[] {
    const exports: ExportedSymbol[] = [];

    for (const decl of sourceFile.getExportedDeclarations()) {
      const [name, nodes] = decl;
      for (const node of nodes) {
        const kind = this.getSymbolKind(node);
        const jsdocNodes = 'getJsDocs' in node ? (node as any).getJsDocs() : [];
        const jsdoc = jsdocNodes.length > 0 ? jsdocNodes[0].getDescription().trim() : undefined;

        // Try to enrich with Lens state matrix
        let stateMatrix: number[][] | undefined;
        if (lensIndex?.entriesMap) {
          // Lens id format is "relPath:functionName"
          const lensId = `${relPath}:${name}`;
          const entry = lensIndex.entriesMap.get(lensId);
          if (entry) {
            stateMatrix = entry.matrix;
          }
        }

        exports.push({
          name,
          kind,
          filepath: relPath,
          line: node.getStartLineNumber(),
          signature: this.getSignature(node, name),
          jsdoc,
          isExported: true,
          stateMatrix
        });
      }
    }

    return exports;
  }

  private getSymbolKind(node: Node): ExportedSymbol['kind'] {
    const kind = node.getKind();
    switch (kind) {
      case SyntaxKind.FunctionDeclaration: return 'function';
      case SyntaxKind.ClassDeclaration: return 'class';
      case SyntaxKind.InterfaceDeclaration: return 'interface';
      case SyntaxKind.TypeAliasDeclaration: return 'type';
      case SyntaxKind.EnumDeclaration: return 'enum';
      case SyntaxKind.VariableDeclaration: return 'variable';
      default: return 'const';
    }
  }

  private getSignature(node: Node, name: string): string {
    const kind = node.getKind();

    if (kind === SyntaxKind.FunctionDeclaration) {
      // Get the full signature without the body
      const text = node.getText();
      const braceIdx = text.indexOf('{');
      return braceIdx > 0 ? text.substring(0, braceIdx).trim() : text.substring(0, 200);
    }

    if (kind === SyntaxKind.ClassDeclaration) {
      const text = node.getText();
      const braceIdx = text.indexOf('{');
      return braceIdx > 0 ? text.substring(0, braceIdx).trim() : `class ${name}`;
    }

    if (kind === SyntaxKind.InterfaceDeclaration) {
      const text = node.getText();
      const braceIdx = text.indexOf('{');
      return braceIdx > 0 ? text.substring(0, braceIdx).trim() : `interface ${name}`;
    }

    if (kind === SyntaxKind.TypeAliasDeclaration) {
      return node.getText().substring(0, 200);
    }

    return `${name}`;
  }

  private extractImports(sourceFile: SourceFile, relPath: string, projectDir: string): ImportEdge[] {
    const imports: ImportEdge[] = [];

    // Regular imports: import { X } from "./y"
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      const isExternal = !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/');

      const namedImports = importDecl.getNamedImports().map((n) => n.getName());
      const defaultImport = importDecl.getDefaultImport()?.getText();
      const symbols = defaultImport ? [defaultImport, ...namedImports] : namedImports;

      imports.push({
        from: relPath,
        to: this.resolveModulePath(moduleSpecifier, relPath, projectDir, isExternal),
        symbols,
        isExternal,
      });
    }

    // Re-exports: export { X } from "./y"
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const moduleSpecifier = exportDecl.getModuleSpecifierValue();
      if (!moduleSpecifier) continue; // Local re-export without module specifier

      const isExternal = !moduleSpecifier.startsWith('.') && !moduleSpecifier.startsWith('/');
      const namedExports = exportDecl.getNamedExports().map((n) => n.getName());

      imports.push({
        from: relPath,
        to: this.resolveModulePath(moduleSpecifier, relPath, projectDir, isExternal),
        symbols: namedExports,
        isExternal,
      });
    }

    return imports;
  }

  private resolveModulePath(moduleSpecifier: string, relPath: string, projectDir: string, isExternal: boolean): string {
    if (isExternal) return moduleSpecifier;
    const fromDir = path.dirname(path.join(projectDir, relPath));
    return path.relative(projectDir, path.resolve(fromDir, moduleSpecifier));
  }

  private detectPatterns(sourceFile: SourceFile, relPath: string): PatternMatch[] {
    const patterns: PatternMatch[] = [];
    const text = sourceFile.getText();
    const fileName = path.basename(relPath).toLowerCase();

    // Repository pattern
    if (fileName.includes('repository') || text.match(/class\s+\w+Repository/)) {
      patterns.push({
        pattern: 'Repository',
        filepath: relPath,
        evidence: 'Class named *Repository — data access abstraction layer',
      });
    }

    // Factory pattern
    if (fileName.includes('factory') || text.match(/class\s+\w+Factory/) || text.match(/function\s+create\w+/)) {
      patterns.push({
        pattern: 'Factory',
        filepath: relPath,
        evidence: 'Factory class or create* function — object creation abstraction',
      });
    }

    // Singleton pattern
    if (text.match(/private\s+static\s+instance/) || text.match(/getInstance\(\)/)) {
      patterns.push({
        pattern: 'Singleton',
        filepath: relPath,
        evidence: 'Static instance + getInstance() — single instance pattern',
      });
    }

    // Strategy/Plugin pattern
    if (fileName.includes('strategy') || fileName.includes('provider') || text.match(/implements\s+\w+(Strategy|Provider|Plugin)/)) {
      patterns.push({
        pattern: 'Strategy/Provider',
        filepath: relPath,
        evidence: 'Implements a Strategy/Provider interface — pluggable behavior',
      });
    }

    // Observer/EventEmitter pattern
    if (text.match(/extends\s+EventEmitter/) || text.match(/\.on\(/) && text.match(/\.emit\(/)) {
      patterns.push({
        pattern: 'Observer/EventEmitter',
        filepath: relPath,
        evidence: 'EventEmitter usage — publish/subscribe pattern',
      });
    }

    // Middleware pattern (Express/Koa)
    if (text.match(/\(req,\s*res,\s*next\)/) || text.match(/app\.use\(/)) {
      patterns.push({
        pattern: 'Middleware',
        filepath: relPath,
        evidence: 'Express-style middleware — request pipeline pattern',
      });
    }

    return patterns;
  }

  private findTestFile(projectDir: string, sourceRelPath: string): string | null {
    const basename = path.basename(sourceRelPath, path.extname(sourceRelPath));
    const dir = path.dirname(sourceRelPath);

    const candidates = [
      // Same directory: foo.test.ts
      path.join(dir, `${basename}.test.ts`),
      path.join(dir, `${basename}.spec.ts`),
      path.join(dir, `${basename}.test.js`),
      path.join(dir, `${basename}.spec.js`),
      // tests/ mirror: tests/foo.test.ts
      path.join('tests', dir, `${basename}.test.ts`),
      path.join('tests', `${basename}.test.ts`),
      path.join('test', dir, `${basename}.test.ts`),
      path.join('__tests__', dir, `${basename}.test.ts`),
      // Tests as sibling directory
      sourceRelPath.replace(/^src\//, 'tests/').replace(/\.(ts|js)$/, '.test.$1'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(path.join(projectDir, candidate))) {
        return candidate;
      }
    }
    return null;
  }

  private findEntryPoints(projectDir: string, modules: ModuleSummary[]): string[] {
    const entries: string[] = [];

    // Check package.json for main/bin
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
      if (pkg.main) entries.push(pkg.main);
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
        entries.push(...(bins as string[]));
      }
    } catch { /* no package.json */ }

    // Common entry point names
    const commonEntries = ['src/index.ts', 'src/main.ts', 'src/app.ts', 'src/server.ts', 'index.ts'];
    for (const entry of commonEntries) {
      if (modules.some((m) => m.filepath === entry) && !entries.includes(entry)) {
        entries.push(entry);
      }
    }

    return entries;
  }

  /**
   * Detect circular dependencies using three-state DFS.
   */
  private findCircularDependencies(imports: ImportEdge[]): string[][] {
    const graph = new Map<string, string[]>();
    for (const edge of imports) {
      if (edge.isExternal) continue;
      if (!graph.has(edge.from)) graph.set(edge.from, []);
      graph.get(edge.from)!.push(edge.to);
    }

    const cycles: string[][] = [];
    const state = new Map<string, 'unvisited' | 'in-progress' | 'done'>();
    for (const node of graph.keys()) state.set(node, 'unvisited');

    const dfs = (node: string, stack: string[]): void => {
      state.set(node, 'in-progress');
      stack.push(node);

      for (const neighbor of graph.get(node) ?? []) {
        const ns = state.get(neighbor);
        if (ns === undefined) continue; // neighbor not in graph
        if (ns === 'in-progress') {
          const cycleStart = stack.indexOf(neighbor);
          cycles.push(stack.slice(cycleStart));
        } else if (ns === 'unvisited') {
          dfs(neighbor, stack);
        }
      }

      stack.pop();
      state.set(node, 'done');
    };

    for (const node of graph.keys()) {
      if (state.get(node) === 'unvisited') dfs(node, []);
    }

    return cycles;
  }
}

/**
 * Pluggable code analyzer framework.
 *
 * Each language analyzer implements the `CodeAnalyzer` interface and produces
 * a standardized `AnalysisResult`. The `AnalyzerRegistry` auto-detects the
 * project language and runs the appropriate analyzer.
 *
 * Current analyzers:
 *   - TypeScript/JavaScript (via ts-morph)
 *
 * Planned:
 *   - C# (via Roslyn / dotnet CLI)
 *   - Python (via pyright / ast)
 *   - C++ (via tree-sitter / compile_commands.json)
 */

export interface ExportedSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'const';
  filepath: string;
  line: number;
  signature: string;          // e.g. "function add(a: number, b: number): number"
  jsdoc?: string;             // Existing documentation
  isExported: boolean;
  stateMatrix?: number[][];    // Optional structural state matrix from Lens
}

export interface ImportEdge {
  from: string;               // Importing module (relative path)
  to: string;                 // Imported module (relative path or package name)
  symbols: string[];          // What's imported
  isExternal: boolean;        // true for node_modules imports
}

export interface ModuleSummary {
  filepath: string;
  exports: ExportedSymbol[];
  imports: ImportEdge[];
  linesOfCode: number;
  hasTests: boolean;           // true if a corresponding test file exists
  testFilepath?: string;       // Path to the test file if it exists
}

export interface PatternMatch {
  pattern: string;             // e.g. "Repository", "Factory", "Singleton"
  filepath: string;
  evidence: string;            // Why we think this pattern is used
}

export interface AnalysisResult {
  language: string;
  projectRoot: string;
  analyzedAt: string;          // ISO timestamp
  modules: ModuleSummary[];
  dependencyGraph: ImportEdge[];
  patterns: PatternMatch[];
  entryPoints: string[];       // Main entry files
  circularDependencies: string[][]; // Groups of files in circular dep chains
  stats: {
    totalFiles: number;
    totalExports: number;
    totalImports: number;
    filesWithTests: number;
    filesWithoutTests: number;
  };
}

/**
 * Interface that every language analyzer must implement.
 */
export interface CodeAnalyzer {
  /** Human-readable name, e.g. "TypeScript Analyzer" */
  readonly name: string;

  /** Languages this analyzer supports */
  readonly languages: string[];

  /**
   * Check if this analyzer can handle the given project.
   * Should be fast — just check for config files / file extensions.
   */
  canAnalyze(projectDir: string): Promise<boolean>;

  /**
   * Run the full analysis. May take seconds for large projects.
   * @param projectDir Absolute path to project root
   * @param options Optional configuration
   */
  analyze(projectDir: string, options?: AnalyzeOptions): Promise<AnalysisResult>;
}

export interface AnalyzeOptions {
  /** Only analyze files that changed since this git ref */
  incrementalSince?: string;
  /** Maximum number of files to analyze (for huge projects) */
  maxFiles?: number;
  /** Glob patterns to exclude */
  exclude?: string[];
}

/**
 * Registry that holds all available analyzers and picks the right one.
 */
export class AnalyzerRegistry {
  private analyzers: CodeAnalyzer[] = [];

  register(analyzer: CodeAnalyzer): void {
    this.analyzers.push(analyzer);
  }

  /**
   * Find all analyzers that can handle this project.
   * A multi-language project may have multiple analyzers.
   */
  async detectAnalyzers(projectDir: string): Promise<CodeAnalyzer[]> {
    const results: CodeAnalyzer[] = [];
    for (const analyzer of this.analyzers) {
      if (await analyzer.canAnalyze(projectDir)) {
        results.push(analyzer);
      }
    }
    return results;
  }

  /**
   * Run all applicable analyzers and merge results.
   */
  async analyzeProject(projectDir: string, options?: AnalyzeOptions): Promise<AnalysisResult[]> {
    const applicable = await this.detectAnalyzers(projectDir);
    if (applicable.length === 0) {
      throw new Error(`No analyzers found for project at ${projectDir}`);
    }

    const results: AnalysisResult[] = [];
    for (const analyzer of applicable) {
      results.push(await analyzer.analyze(projectDir, options));
    }
    return results;
  }

  listAnalyzers(): { name: string; languages: string[] }[] {
    return this.analyzers.map((a) => ({ name: a.name, languages: a.languages }));
  }
}

/**
 * Format an analysis result into a concise prompt section for LLM context.
 */
export function formatAnalysisForPrompt(result: AnalysisResult): string {
  const lines: string[] = [
    `## Code Analysis (${result.language})`,
    `Analyzed: ${result.stats.totalFiles} files, ${result.stats.totalExports} exports`,
    `Test coverage: ${result.stats.filesWithTests}/${result.stats.totalFiles} files have tests`,
    '',
  ];

  // Dependency graph summary (top importers)
  const importCounts = new Map<string, number>();
  for (const edge of result.dependencyGraph) {
    importCounts.set(edge.to, (importCounts.get(edge.to) || 0) + 1);
  }
  const topDeps = [...importCounts.entries()]
    .filter(([dep]) => !result.dependencyGraph.find((e) => e.to === dep)?.isExternal)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topDeps.length > 0) {
    lines.push('### Most-imported internal modules');
    for (const [dep, count] of topDeps) {
      lines.push(`- ${dep} (imported by ${count} files)`);
    }
    lines.push('');
  }

  // Circular dependencies
  if (result.circularDependencies.length > 0) {
    lines.push('### ⚠️ Circular dependencies');
    for (const cycle of result.circularDependencies.slice(0, 5)) {
      lines.push(`- ${cycle.join(' → ')}`);
    }
    lines.push('');
  }

  // Detected patterns
  if (result.patterns.length > 0) {
    lines.push('### Detected patterns');
    for (const p of result.patterns) {
      lines.push(`- **${p.pattern}** in ${p.filepath}: ${p.evidence}`);
    }
    lines.push('');
  }

  // Files without tests
  const untested = result.modules.filter((m) => !m.hasTests && m.exports.length > 0);
  if (untested.length > 0) {
    lines.push(`### Files without tests (${untested.length})`);
    for (const m of untested.slice(0, 10)) {
      lines.push(`- ${m.filepath} (${m.exports.length} exports)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Merge multiple analysis results (from different language analyzers) into a combined prompt.
 */
export function formatMultiAnalysisForPrompt(results: AnalysisResult[]): string {
  if (results.length === 0) return '';
  return results.map(formatAnalysisForPrompt).join('\n---\n\n');
}

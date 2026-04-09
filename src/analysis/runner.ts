import * as fs from 'fs';
import * as path from 'path';
import { resolveContainedPath } from '../utils/path-safety.js';
import { getLogger } from '../utils/logger.js';
import { LLMClient } from '../llm/client.js';
import { AnalyzerRegistry, formatMultiAnalysisForPrompt, type AnalysisResult, type AnalyzeOptions } from './types.js';
import { TypeScriptAnalyzer } from './typescript-analyzer.js';
import { CSharpAnalyzer } from './csharp-analyzer.js';
import { CppAnalyzer } from './cpp-analyzer.js';

const ANALYSIS_DIR = '.tdd-workflow/analysis';

/**
 * Create the default registry with all built-in analyzers.
 */
export function createDefaultRegistry(): AnalyzerRegistry {
  const registry = new AnalyzerRegistry();
  registry.register(new TypeScriptAnalyzer());
  registry.register(new CSharpAnalyzer());
  // Future: registry.register(new PythonAnalyzer());
  registry.register(new CppAnalyzer());
  return registry;
}

/**
 * Run analysis on a project and persist results.
 * Returns the analysis results and optionally generates LLM documentation.
 */
export async function analyzeProject(
  projectDir: string,
  options?: AnalyzeOptions & { generateDocs?: boolean; llm?: LLMClient }
): Promise<{ results: AnalysisResult[]; docsPath?: string }> {
  const logger = getLogger();
  const registry = createDefaultRegistry();

  // 1. Run algorithmic analysis
  logger.info('Running code analysis...');
  const results = await registry.analyzeProject(projectDir, options);

  // 2. Persist analysis results
  // Defense-in-depth: verify the analysis output directory stays inside projectDir.
  // ANALYSIS_DIR is a module constant, but an explicit check prevents surprises
  // if the constant is ever changed to something unexpected.
  const analysisDir = resolveContainedPath(path.resolve(projectDir), ANALYSIS_DIR);
  fs.mkdirSync(analysisDir, { recursive: true });

  for (const result of results) {
    const filename = `${result.language}-analysis.json`;
    fs.writeFileSync(
      path.join(analysisDir, filename),
      JSON.stringify(result, null, 2),
      'utf-8'
    );
    logger.info(`Saved ${filename}: ${result.stats.totalFiles} files, ${result.stats.totalExports} exports`);
  }

  // Save a human-readable summary
  const summaryPath = path.join(analysisDir, 'summary.md');
  fs.writeFileSync(summaryPath, formatMultiAnalysisForPrompt(results), 'utf-8');

  // 3. Optionally generate LLM documentation
  let docsPath: string | undefined;
  if (options?.generateDocs && options?.llm) {
    docsPath = await generateArchitectureDocs(projectDir, results, options.llm);
  }

  return { results, docsPath };
}

/**
 * Load cached analysis results from disk if they exist.
 */
export function loadCachedAnalysis(projectDir: string): AnalysisResult[] | null {
  const analysisDir = path.join(projectDir, ANALYSIS_DIR);
  if (!fs.existsSync(analysisDir)) return null;

  const results: AnalysisResult[] = [];
  for (const file of fs.readdirSync(analysisDir)) {
    if (file.endsWith('-analysis.json')) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(analysisDir, file), 'utf-8'));
        results.push(data);
      } catch { /* corrupted file */ }
    }
  }

  return results.length > 0 ? results : null;
}

/**
 * Check if cached analysis is stale (files changed since last analysis).
 */
export function isAnalysisStale(projectDir: string): boolean {
  const analysisDir = path.join(projectDir, ANALYSIS_DIR);
  const summaryPath = path.join(analysisDir, 'summary.md');

  if (!fs.existsSync(summaryPath)) return true;

  const analysisMtime = fs.statSync(summaryPath).mtimeMs;
  const srcDir = path.join(projectDir, 'src');

  if (!fs.existsSync(srcDir)) return true;

  // Check if any source file is newer than the analysis
  try {
    const files = fs.readdirSync(srcDir, { recursive: true }) as string[];
    for (const file of files) {
      const filePath = path.join(srcDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && stat.mtimeMs > analysisMtime) {
          return true;
        }
      } catch { /* file access error */ }
    }
  } catch { /* directory read error */ }

  return false;
}

const ARCHITECTURE_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string', description: 'High-level description of what this project does and its architecture style.' },
    layers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          modules: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'modules'],
      },
    },
    dataFlow: { type: 'string', description: 'How data flows through the system (e.g., HTTP → Controller → Service → DB).' },
    keyDecisions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Inferred architectural decisions and trade-offs.',
    },
    risks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Potential risks: tight coupling, missing tests, circular deps, etc.',
    },
  },
  required: ['overview', 'layers', 'dataFlow', 'keyDecisions', 'risks'],
};

interface ArchitectureDoc {
  overview: string;
  layers: { name: string; description: string; modules: string[] }[];
  dataFlow: string;
  keyDecisions: string[];
  risks: string[];
}

/**
 * Use an LLM to generate human-readable architecture documentation from analysis results.
 */
async function generateArchitectureDocs(
  projectDir: string,
  results: AnalysisResult[],
  llm: LLMClient
): Promise<string> {
  const logger = getLogger();
  logger.info('Generating architecture documentation...');

  const analysisContext = formatMultiAnalysisForPrompt(results);

  // Build a module listing with signatures
  const moduleDetails: string[] = [];
  for (const result of results) {
    for (const mod of result.modules.slice(0, 30)) { // Cap at 30 modules for prompt size
      if (mod.exports.length === 0) continue;
      const exports = mod.exports.map((e) => `  ${e.signature}`).join('\n');
      moduleDetails.push(`### ${mod.filepath} (${mod.linesOfCode} lines)\n${exports}`);
    }
  }

  const systemPrompt = `You are a senior software architect documenting an existing codebase.

${analysisContext}

## Module Details
${moduleDetails.join('\n\n')}

Analyze the code structure and produce architecture documentation. Be specific about:
1. What the project does (infer from module names, patterns, and dependencies)
2. How layers are organized (group modules into logical layers)
3. How data flows through the system
4. Key architectural decisions you can infer
5. Risks and areas of concern (circular deps, untested modules, tight coupling)`;

  const doc = await llm.askStructured<ArchitectureDoc>(
    systemPrompt,
    'Generate architecture documentation for this project.',
    ARCHITECTURE_SCHEMA,
    'plan',
    0.1
  );

  // Write as markdown
  const docsDir = path.join(projectDir, ANALYSIS_DIR);
  const docsPath = path.join(docsDir, 'ARCHITECTURE.md');

  const markdown = [
    '# Architecture Documentation',
    `*Auto-generated on ${new Date().toISOString()}*`,
    '',
    '## Overview',
    doc.overview,
    '',
    '## System Layers',
    ...doc.layers.map((l) => [
      `### ${l.name}`,
      l.description,
      '',
      'Modules:',
      ...l.modules.map((m) => `- ${m}`),
      '',
    ].join('\n')),
    '## Data Flow',
    doc.dataFlow,
    '',
    '## Key Architectural Decisions',
    ...doc.keyDecisions.map((d) => `- ${d}`),
    '',
    '## Risks & Concerns',
    ...doc.risks.map((r) => `- ⚠️ ${r}`),
  ].join('\n');

  fs.writeFileSync(docsPath, markdown, 'utf-8');
  logger.info(`Architecture documentation written to ${docsPath}`);

  return docsPath;
}

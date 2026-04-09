import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../utils/logger.js';
import { loadCachedAnalysis } from '../analysis/runner.js';
import { formatMultiAnalysisForPrompt } from '../analysis/types.js';
import { execFileAsync, DEFAULT_MAX_BUFFER } from '../utils/exec.js';

// exec is still used for getFileTree which needs shell pipes (fully hardcoded, no user input)
const execAsync = promisify(exec);

export interface WorkspaceSnapshot {
  projectName: string;
  language: string;
  framework: string | null;
  testFramework: string;
  fileTree: string;
  packageJson: string;
  tsconfigJson: string | null;
  existingTestExample: string | null;
  existingSourceExample: string | null;
  relevantFiles: { filepath: string; content: string }[];
  analysisContext: string | null;  // Pre-computed code analysis summary
}

export async function gatherWorkspaceSnapshot(
  projectDir: string,
  taskDescription?: string,
): Promise<WorkspaceSnapshot> {
  const logger = getLogger();
  logger.info(`Gathering workspace snapshot from ${projectDir}`);

  const pkgJsonPath = path.join(projectDir, 'package.json');
  const tsconfigPath = path.join(projectDir, 'tsconfig.json');

  let packageJson = '';
  let projectName = 'unknown';
  let framework: string | null = null;
  let testFramework = 'unknown';

  if (fs.existsSync(pkgJsonPath)) {
    packageJson = fs.readFileSync(pkgJsonPath, 'utf-8');
    try {
      const pkg = JSON.parse(packageJson);
      projectName = pkg.name || 'unknown';
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      framework = detectFramework(allDeps);
      testFramework = detectTestFramework(allDeps);
    } catch { /* malformed package.json */ }
  }

  const language = fs.existsSync(tsconfigPath) ? 'typescript' : 'javascript';
  const tsconfigJson = fs.existsSync(tsconfigPath)
    ? fs.readFileSync(tsconfigPath, 'utf-8')
    : null;

  const fileTree = await getFileTree(projectDir);
  const existingTestExample = await findExampleFile(projectDir, 'test');
  const existingSourceExample = await findExampleFile(projectDir, 'source');

  let relevantFiles: { filepath: string; content: string }[] = [];
  if (taskDescription) {
    relevantFiles = await findRelevantFiles(projectDir, taskDescription);
  }

  // Load cached analysis if available
  let analysisContext: string | null = null;
  const cachedAnalysis = loadCachedAnalysis(projectDir);
  if (cachedAnalysis) {
    analysisContext = formatMultiAnalysisForPrompt(cachedAnalysis);
    logger.info(`Loaded cached code analysis (${cachedAnalysis.length} language(s))`);
  }

  return {
    projectName,
    language,
    framework,
    testFramework,
    fileTree,
    packageJson,
    tsconfigJson,
    existingTestExample,
    existingSourceExample,
    relevantFiles,
    analysisContext,
  };
}

export function detectFramework(deps: Record<string, string>): string | null {
  if (deps['next']) return 'next';
  if (deps['express']) return 'express';
  if (deps['fastify']) return 'fastify';
  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['react']) return 'react';
  if (deps['vue']) return 'vue';
  if (deps['angular']) return 'angular';
  return null;
}

export function detectTestFramework(deps: Record<string, string>): string {
  if (deps['vitest']) return 'vitest';
  if (deps['jest']) return 'jest';
  if (deps['mocha']) return 'mocha';
  if (deps['ava']) return 'ava';
  return 'unknown';
}

async function getFileTree(projectDir: string): Promise<string> {
  try {
    // This command is fully hardcoded — no user input is interpolated — so using
    // exec (shell) here is acceptable and lets us use pipes cleanly.
    const { stdout } = await execAsync(
      'find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/.tdd-workflow/*" | sort | head -200',
      { cwd: projectDir, maxBuffer: DEFAULT_MAX_BUFFER }
    );
    return stdout.trim();
  } catch {
    return '(could not read file tree)';
  }
}

/**
 * Find an example test or source file by walking the src/ directory with Node fs.
 * Replaces the previous `find -regextype posix-extended` command which is Linux-only.
 */
async function findExampleFile(
  projectDir: string,
  type: 'test' | 'source'
): Promise<string | null> {
  try {
    const srcDir = path.join(projectDir, 'src');
    if (!fs.existsSync(srcDir)) return null;

    const isTestFile = (name: string) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(name);
    const isSourceFile = (name: string) => /\.(ts|js|tsx|jsx)$/.test(name) && !isTestFile(name);
    const predicate = type === 'test' ? isTestFile : isSourceFile;

    const found = walkForFirst(srcDir, predicate);
    if (!found) return null;

    const relativePath = './' + path.relative(projectDir, found).replace(/\\/g, '/');
    const content = fs.readFileSync(found, 'utf-8');
    return `// File: ${relativePath}\n${content.substring(0, 3000)}`;
  } catch {
    return null;
  }
}

/**
 * Recursively walk a directory and return the first file matching predicate.
 */
function walkForFirst(dir: string, predicate: (name: string) => boolean): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
      const found = walkForFirst(fullPath, predicate);
      if (found) return found;
    } else if (entry.isFile() && predicate(entry.name)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Find files relevant to a task by grepping for extracted keywords.
 * Uses execFile (no shell) so keyword values cannot inject shell commands.
 */
async function findRelevantFiles(
  projectDir: string,
  taskDescription: string
): Promise<{ filepath: string; content: string }[]> {
  const keywords = extractKeywords(taskDescription);
  const foundFiles = new Set<string>();

  for (const keyword of keywords.slice(0, 5)) {
    try {
      // execFileAsync does not spawn a shell — keyword is passed as a plain argument,
      // so shell metacharacters in keywords have no effect.
      const { stdout } = await execFileAsync(
        'grep',
        ['-rl', keyword, '--include=*.ts', '--include=*.js', '.'],
        { cwd: projectDir, maxBuffer: DEFAULT_MAX_BUFFER }
      );
      for (const f of stdout.trim().split('\n').filter(Boolean).slice(0, 3)) {
        foundFiles.add(f);
      }
    } catch { /* grep exits 1 on no matches — not an error */ }
  }

  const results: { filepath: string; content: string }[] = [];
  for (const filepath of [...foundFiles].slice(0, 8)) {
    try {
      const fullPath = path.resolve(projectDir, filepath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      results.push({ filepath, content: content.substring(0, 4000) });
    } catch { /* unreadable */ }
  }
  return results;
}

export function extractKeywords(text: string): string[] {
  // Remove common English stop-words and short words
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'be', 'been',
    'that', 'this', 'it', 'not', 'do', 'does', 'did', 'will', 'would',
    'should', 'could', 'can', 'have', 'has', 'had', 'being', 'its',
    'add', 'create', 'build', 'implement', 'make', 'write', 'new',
  ]);

  return text
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()))
    .map((w) => w.toLowerCase())
    .filter((w, i, arr) => arr.indexOf(w) === i); // unique
}

export function formatSnapshotForPrompt(snapshot: WorkspaceSnapshot): string {
  let prompt = `## Project Context\n`;
  prompt += `- Name: ${snapshot.projectName}\n`;
  prompt += `- Language: ${snapshot.language}\n`;
  prompt += `- Framework: ${snapshot.framework || 'none'}\n`;
  prompt += `- Test Framework: ${snapshot.testFramework}\n\n`;

  prompt += `## File Tree\n\`\`\`\n${snapshot.fileTree}\n\`\`\`\n\n`;

  if (snapshot.packageJson) {
    prompt += `## package.json\n\`\`\`json\n${snapshot.packageJson}\n\`\`\`\n\n`;
  }

  if (snapshot.existingTestExample) {
    prompt += `## Existing Test Pattern\n\`\`\`typescript\n${snapshot.existingTestExample}\n\`\`\`\n\n`;
  }

  if (snapshot.existingSourceExample) {
    prompt += `## Existing Source Pattern\n\`\`\`typescript\n${snapshot.existingSourceExample}\n\`\`\`\n\n`;
  }

  if (snapshot.relevantFiles.length > 0) {
    prompt += `## Relevant Existing Files\n`;
    for (const f of snapshot.relevantFiles) {
      prompt += `### ${f.filepath}\n\`\`\`\n${f.content}\n\`\`\`\n\n`;
    }
  }

  if (snapshot.analysisContext) {
    prompt += snapshot.analysisContext + '\n\n';
  }

  return prompt;
}

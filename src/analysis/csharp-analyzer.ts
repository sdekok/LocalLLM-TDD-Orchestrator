import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import { getLogger } from '../utils/logger.js';
import type {
  CodeAnalyzer,
  AnalyzeOptions,
  AnalysisResult,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execFileAsync = promisify(execFile);

async function findAnalyzerDll(analyzerDir: string): Promise<string> {
  const releasePattern = path.join(analyzerDir, 'bin', 'Release', 'net*', 'CsharpAstAnalyzer.dll');
  const releaseMatches = await glob(releasePattern);
  if (releaseMatches.length > 0) return releaseMatches[0]!;

  const debugPattern = path.join(analyzerDir, 'bin', 'Debug', 'net*', 'CsharpAstAnalyzer.dll');
  const debugMatches = await glob(debugPattern);
  if (debugMatches.length > 0) return debugMatches[0]!;

  throw new Error(`CsharpAstAnalyzer.dll not found in ${analyzerDir}. Run 'dotnet build' first.`);
}

export class CSharpAnalyzer implements CodeAnalyzer {
  readonly name = 'C# AST Analyzer';
  readonly languages = ['csharp'];

  async canAnalyze(projectDir: string): Promise<boolean> {
    try {
      const files = await fs.promises.readdir(projectDir);
      return files.some(file => file.endsWith('.csproj') || file.endsWith('.sln'));
    } catch {
      return false;
    }
  }

  async analyze(projectDir: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
    const logger = getLogger();
    logger.info(`C# analysis starting: ${projectDir}`);

    const allCsFiles: string[] = [];
    
    // Fast directory traversal to find .cs files
    const walk = async (dir: string) => {
      const list = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const dirent of list) {
        if (dirent.name === 'bin' || dirent.name === 'obj' || dirent.name === 'node_modules' || dirent.name.startsWith('.')) {
          continue;
        }
        const res = path.resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
          await walk(res);
        } else if (res.endsWith('.cs')) {
          if (!options?.exclude?.some(ex => res.includes(ex))) {
            allCsFiles.push(res);
          }
        }
      }
    };

    await walk(projectDir);

    let filesToProcess = allCsFiles;
    if (options?.maxFiles && filesToProcess.length > options.maxFiles) {
      filesToProcess = filesToProcess.slice(0, options.maxFiles);
    }

    if (filesToProcess.length === 0) {
      logger.warn('No .cs files found for AST parsing.');
      return {
        language: 'csharp',
        projectRoot: projectDir,
        analyzedAt: new Date().toISOString(),
        modules: [],
        dependencyGraph: [],
        patterns: [],
        entryPoints: [],
        circularDependencies: [],
        stats: {
          totalFiles: 0,
          totalExports: 0,
          totalImports: 0,
          filesWithTests: 0,
          filesWithoutTests: 0
        }
      };
    }

    const dllPath = await findAnalyzerDll(path.resolve(__dirname, 'tools', 'CsharpAstAnalyzer'));

    try {
      // Chunk arguments if there are too many files (max args limit on linux is large, but to be safe we can pass all)
      const { stdout } = await execFileAsync('dotnet', [dllPath, projectDir, ...filesToProcess], {
        maxBuffer: 1024 * 1024 * 50 // 50MB buffer for large JSON outputs
      });

      const result = JSON.parse(stdout) as AnalysisResult;
      
      // C# namespace-level circular dep detection not yet implemented
      result.circularDependencies = [];
      
      return result;
    } catch (err: any) {
      logger.error(`C# analysis execution failed: ${err.message}`);
      throw err;
    }
  }

}

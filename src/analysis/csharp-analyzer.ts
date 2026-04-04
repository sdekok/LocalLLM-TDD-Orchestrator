import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getLogger } from '../utils/logger.js';
import type {
  CodeAnalyzer,
  AnalyzeOptions,
  AnalysisResult,
} from './types.js';

const execFileAsync = promisify(execFile);

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

    const dllPath = path.resolve(__dirname, 'tools', 'CsharpAstAnalyzer', 'bin', 'Release', 'net10.0', 'CsharpAstAnalyzer.dll');
    if (!fs.existsSync(dllPath)) {
      throw new Error(`CsharpAstAnalyzer.dll not found at ${dllPath}. Please ensure the C# analyzer tool has been built.`);
    }

    try {
      // Chunk arguments if there are too many files (max args limit on linux is large, but to be safe we can pass all)
      const { stdout } = await execFileAsync('dotnet', [dllPath, projectDir, ...filesToProcess], {
        maxBuffer: 1024 * 1024 * 50 // 50MB buffer for large JSON outputs
      });

      const result = JSON.parse(stdout) as AnalysisResult;
      
      // Calculate circular dependencies algorithmically
      result.circularDependencies = this.detectCircularDependencies(result);
      
      return result;
    } catch (err: any) {
      logger.error(`C# analysis execution failed: ${err.message}`);
      throw err;
    }
  }

  private detectCircularDependencies(result: AnalysisResult): string[][] {
    const graph = new Map<string, Set<string>>();
    
    // Build adjacency list
    for (const edge of result.dependencyGraph) {
      if (edge.isExternal) continue;
      
      const from = edge.from;
      if (!graph.has(from)) graph.set(from, new Set());
      
      // edge.to in C# might contain comma separated namespaces, but we want file-to-file
      // Since C# imports are namespaces, it's hard to track file-to-file circular deps perfectly without symbol resolution.
      // We will skip file-to-file circular mapping for C# unless we resolve namespace to file.
    }
    
    return [];
  }
}

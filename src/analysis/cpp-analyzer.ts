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

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const CppLanguage = require('tree-sitter-cpp');

export class CppAnalyzer implements CodeAnalyzer {
  readonly name = 'C++ AST Analyzer';
  readonly languages = ['cpp', 'c'];

  async canAnalyze(projectDir: string): Promise<boolean> {
    try {
      const files = await fs.promises.readdir(projectDir);
      return files.some(file => file === 'CMakeLists.txt' || file.endsWith('.vcxproj') || file.endsWith('.cpp'));
    } catch {
      return false;
    }
  }

  async analyze(projectDir: string, options?: AnalyzeOptions): Promise<AnalysisResult> {
    const logger = getLogger();
    logger.info(`C++ analysis starting: ${projectDir}`);

    const allCppFiles: string[] = [];
    
    // Directory traversal to find .cpp, .hpp, .h, .c, .cc files
    const walk = async (dir: string) => {
      const list = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const dirent of list) {
        if (dirent.name === 'build' || dirent.name === 'node_modules' || dirent.name.startsWith('.')) {
          continue;
        }
        const res = path.resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
          await walk(res);
        } else if (res.match(/\.(cpp|hpp|h|cc|c)$/)) {
          if (!options?.exclude?.some(ex => res.includes(ex))) {
            allCppFiles.push(res);
          }
        }
      }
    };
    await walk(projectDir);

    let filesToProcess = allCppFiles;
    if (options?.maxFiles && filesToProcess.length > options.maxFiles) {
      filesToProcess = filesToProcess.slice(0, options.maxFiles);
    }

    const result: AnalysisResult = {
      language: 'cpp',
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

    if (filesToProcess.length === 0) {
      return result;
    }

    try {
      const parser = new Parser();
      parser.setLanguage(CppLanguage);

      const allImports: ImportEdge[] = [];
      const allPatterns: PatternMatch[] = [];

      for (const file of filesToProcess) {
        const sourceCode = fs.readFileSync(file, 'utf8');
        const tree = parser.parse(sourceCode);
        const relPath = path.relative(projectDir, file).replace(/\\/g, '/');

        const exports: ExportedSymbol[] = [];
        const imports: ImportEdge[] = [];
        let hasTests = relPath.toLowerCase().includes('test');

        const cursor = tree.walk();
        let reachedRoot = false;

        while (!reachedRoot) {
          const type = cursor.nodeType;

          // Extract Imports (Includes)
          if (type === 'preproc_include') {
             const pathNode = cursor.currentNode.child(1);
             if (pathNode) {
               const isExternal = pathNode.type === 'system_lib_string';
               // system_lib_string: <iostream> => strip < >
               // string_literal: "service.hpp" => get string_content child or strip quotes
               let cleanPath: string;
               if (isExternal) {
                 cleanPath = pathNode.text.replace(/[<>]/g, '');
               } else {
                 const content = pathNode.childForFieldName('string_content') ?? pathNode.children?.find((c: any) => c.type === 'string_content');
                 cleanPath = content ? content.text : pathNode.text.replace(/["]/g, '');
               }
               const edge = {
                 from: relPath,
                 to: cleanPath,
                 symbols: [cleanPath],
                 isExternal
               };
               imports.push(edge);
               allImports.push(edge);
             }
          }

          // Extract Exports (Classes, Structs, Enums)
          if (type === 'class_specifier' || type === 'struct_specifier' || type === 'enum_specifier') {
             const nameNode = cursor.currentNode.childForFieldName('name');
             if (nameNode) {
               exports.push({
                 name: nameNode.text,
                 kind: type.split('_')[0] as any, // class, struct, enum
                 filepath: relPath,
                 line: cursor.currentNode.startPosition.row + 1,
                 signature: `${type.split('_')[0]} ${nameNode.text}`,
                 isExported: true
               });
             }
             
             // Patterns
             if (type === 'class_specifier') {
               if (sourceCode.includes('public testing::Test') || sourceCode.includes('TEST_F(')) {
                 hasTests = true;
               }
               if (cursor.currentNode.text.includes('virtual') && cursor.currentNode.text.includes('= 0')) {
                 allPatterns.push({ pattern: 'Abstract Class', filepath: relPath, evidence: `Pure virtual function found in ${nameNode?.text}` });
               }
               if (cursor.currentNode.text.includes('static') && cursor.currentNode.text.includes('instance()')) {
                 allPatterns.push({ pattern: 'Singleton', filepath: relPath, evidence: `static instance() found in ${nameNode?.text}` });
               }
             }
          }

          if (type === 'function_definition' && cursor.currentNode.parent?.type === 'translation_unit') {
             const funcDecl = cursor.currentNode.childForFieldName('declarator');
             if (funcDecl) {
               // function_declarator has a nested 'declarator' field which is the identifier
               const nameNode = funcDecl.childForFieldName('declarator') || funcDecl;
               const funcName = nameNode.text;
               exports.push({
                 name: funcName,
                 kind: 'function',
                 filepath: relPath,
                 line: cursor.currentNode.startPosition.row + 1,
                 signature: funcDecl.text,
                 isExported: true
               });
             }
             if (sourceCode.includes('TEST(') || sourceCode.includes('TEST_CASE(')) {
               hasTests = true;
             }
          }

          if (cursor.gotoFirstChild()) {
            continue;
          }
          if (cursor.gotoNextSibling()) {
            continue;
          }
          let retracing = true;
          while (retracing) {
            if (!cursor.gotoParent()) {
              retracing = false;
              reachedRoot = true;
            } else if (cursor.gotoNextSibling()) {
              retracing = false;
            }
          }
        }

        result.modules.push({
          filepath: relPath,
          exports,
          imports,
          linesOfCode: sourceCode.split('\n').length,
          hasTests
        });
      }

      result.dependencyGraph = allImports;
      result.patterns = allPatterns;
      result.stats.totalFiles = result.modules.length;
      result.stats.totalExports = result.modules.reduce((acc: number, m: ModuleSummary) => acc + m.exports.length, 0);
      result.stats.totalImports = result.modules.reduce((acc: number, m: ModuleSummary) => acc + m.imports.length, 0);
      result.stats.filesWithTests = result.modules.filter((m: ModuleSummary) => m.hasTests).length;
      result.stats.filesWithoutTests = result.stats.totalFiles - result.stats.filesWithTests;

      return result;

    } catch (err: any) {
      logger.error(`C++ analysis failed: ${err.message}`);
      throw err;
    }
  }
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { CSharpAnalyzer } from '../../src/analysis/csharp-analyzer.js';

const TEST_DIR = path.join(__dirname, 'fixtures', 'csharp-project');
const ANALYZER_DIR = path.resolve(__dirname, '../../src/analysis/tools/CsharpAstAnalyzer');

async function isDllAvailable(): Promise<boolean> {
  const matches = await glob(path.join(ANALYZER_DIR, 'bin', '{Release,Debug}', 'net*', 'CsharpAstAnalyzer.dll'));
  return matches.length > 0;
}

describe('CSharpAnalyzer', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'TestProject.csproj'), '<Project></Project>');
    fs.writeFileSync(path.join(TEST_DIR, 'Program.cs'), `
using System;
using Microsoft.Extensions.Logging;

namespace TestProject {
  public class Program {
    public static void Main() {}
  }
}
    `);
    fs.writeFileSync(path.join(TEST_DIR, 'UserService.cs'), `
using System.Collections.Generic;

namespace TestProject.Services {
  public interface IUserService { }
  public class UserService : IUserService { }
}
    `);
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('can analyze a C# project', async () => {
    const analyzer = new CSharpAnalyzer();
    expect(await analyzer.canAnalyze(TEST_DIR)).toBe(true);
    expect(await analyzer.canAnalyze(__dirname)).toBe(false);
  });

  it('analyzes exports and imports correctly', async () => {
    if (!await isDllAvailable()) {
      console.log('Skipping: CsharpAstAnalyzer.dll not built (run npm run build:csharp)');
      return;
    }
    const analyzer = new CSharpAnalyzer();
    const result = await analyzer.analyze(TEST_DIR);

    expect(result.language).toBe('csharp');
    expect(result.modules).toHaveLength(2);

    const programModule = result.modules.find(m => m.filepath.endsWith('Program.cs'));
    expect(programModule).toBeDefined();
    expect(programModule?.imports.some(i => i.to.includes('System'))).toBe(true);
    expect(programModule?.exports.some(e => e.name === 'Program' && e.kind === 'class')).toBe(true);
  });
});

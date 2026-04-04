import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CppAnalyzer } from '../../src/analysis/cpp-analyzer.js';

const TEST_DIR = path.join(__dirname, 'fixtures', 'cpp-project');

describe('CppAnalyzer', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'CMakeLists.txt'), 'project(Test)');
    fs.writeFileSync(path.join(TEST_DIR, 'main.cpp'), `
#include <iostream>
#include "service.hpp"

int main() {
    return 0;
}
    `);
    fs.writeFileSync(path.join(TEST_DIR, 'service.hpp'), `
#pragma once
#include <string>

namespace app {
    class Service {
    public:
        virtual ~Service() = 0;
        virtual void initialize() = 0;
    };

    struct OutputData {
        int x;
    };
}
    `);
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('can analyze a C++ project', async () => {
    const analyzer = new CppAnalyzer();
    expect(await analyzer.canAnalyze(TEST_DIR)).toBe(true);
    expect(await analyzer.canAnalyze(__dirname)).toBe(false);
  });

  it('analyzes imports and exports correctly via web-tree-sitter', async () => {
    const analyzer = new CppAnalyzer();
    const result = await analyzer.analyze(TEST_DIR);

    expect(result.language).toBe('cpp');
    expect(result.modules.length).toBeGreaterThan(0);

    const mainModule = result.modules.find(m => m.filepath.endsWith('main.cpp'));
    expect(mainModule).toBeDefined();
    // main.cpp should import <iostream> and "service.hpp"
    expect(mainModule?.imports.some(i => i.to === 'iostream' && i.isExternal)).toBe(true);
    expect(mainModule?.imports.some(i => i.to === 'service.hpp' && !i.isExternal)).toBe(true);
    expect(mainModule?.exports.some(e => e.name === 'main' && e.kind === 'function')).toBe(true);

    const serviceModule = result.modules.find(m => m.filepath.endsWith('service.hpp'));
    expect(serviceModule).toBeDefined();
    expect(serviceModule?.exports.some(e => e.name === 'Service' && e.kind === 'class')).toBe(true);
    expect(serviceModule?.exports.some(e => e.name === 'OutputData' && e.kind === 'struct')).toBe(true);
    
    // Abstract pattern detection
    const pattern = result.patterns.find(p => p.filepath.endsWith('service.hpp'));
    expect(pattern).toBeDefined();
    expect(pattern?.pattern).toBe('Abstract Class');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { StateManager } from '../../src/orchestrator/state.js';
import { Sandbox } from '../../src/orchestrator/sandbox.js';
import { runQualityGates, detectTestCommand, formatGateFailures } from '../../src/orchestrator/quality-gates.js';
import { gatherWorkspaceSnapshot, formatSnapshotForPrompt } from '../../src/context/gatherer.js';

const execAsync = promisify(exec);

/**
 * Integration tests that exercise the full pipeline without an actual LLM.
 * These test the orchestrator's mechanical behavior: state → sandbox → file write → quality gates → merge/rollback.
 */
describe('Orchestrator Integration', () => {
  let projectDir: string;

  beforeEach(async () => {
    // Create a realistic mini Node.js project
    projectDir = path.join(os.tmpdir(), `tdd-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        type: 'module',
        scripts: { test: 'node --test tests/' },
        devDependencies: {},
      }, null, 2)
    );

    fs.writeFileSync(
      path.join(projectDir, 'src', 'index.ts'),
      'export function hello(): string { return "hello"; }\n'
    );

    // Init git repo with local user config (for environments without global gitconfig)
    await execAsync(
      'git init && git config user.email "test@test.com" && git config user.name "Test" && git add -A && git commit -m "init"',
      { cwd: projectDir }
    );
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // ─── State + Sandbox Integration ────────────────────────────────

  it('creates workflow state and sandbox branch in a real project', async () => {
    const state = new StateManager(projectDir);
    state.initWorkflow('Add a greeting function');
    state.setSubtasks([
      { id: 'task-1', description: 'Create greeting module' },
      { id: 'task-2', description: 'Add greeting tests' },
    ]);

    expect(state.hasWorkflow()).toBe(true);
    expect(state.getSummary().total).toBe(2);

    const sandbox = new Sandbox(projectDir);
    const originalBranch = await sandbox.getCurrentBranch();

    await sandbox.createBranch('tdd-workflow/task-1');
    sandbox.writeFiles([
      { filepath: 'src/greeting.ts', content: 'export function greet(name: string) { return `Hello, ${name}!`; }\n' },
    ]);
    await sandbox.commit('Add greeting module');

    // Verify file exists on branch
    expect(fs.existsSync(path.join(projectDir, 'src/greeting.ts'))).toBe(true);

    // Merge back
    await sandbox.mergeAndCleanup('tdd-workflow/task-1', originalBranch);
    expect(fs.existsSync(path.join(projectDir, 'src/greeting.ts'))).toBe(true);
  });

  it('rolls back sandbox branch on failure', async () => {
    const sandbox = new Sandbox(projectDir);
    const originalBranch = await sandbox.getCurrentBranch();

    await sandbox.createBranch('tdd-workflow/bad-attempt');
    sandbox.writeFiles([
      { filepath: 'src/bad-code.ts', content: 'this will fail type checking\n' },
    ]);

    // Simulate gate failure — rollback
    await sandbox.rollback(originalBranch);

    // Bad file should be gone
    expect(fs.existsSync(path.join(projectDir, 'src/bad-code.ts'))).toBe(false);
  });

  // ─── Quality Gates Integration ──────────────────────────────────

  it('detects test command from package.json', async () => {
    const cmd = await detectTestCommand(projectDir);
    // Has `npm test` script → should return 'npm test'
    expect(cmd).toBe('npm test');
  });

  it('formats gate failures readably', () => {
    const report = {
      gates: [
        { gate: 'typescript', passed: false, output: 'src/index.ts(5,3): error TS2345', blocking: true },
        { gate: 'tests', passed: true, output: '3 tests passed', blocking: true },
        { gate: 'lint', passed: false, output: '2 warnings', blocking: false },
      ],
      allBlockingPassed: false,
    };

    const formatted = formatGateFailures(report);
    expect(formatted).toContain('TYPESCRIPT');
    expect(formatted).toContain('BLOCKING');
    expect(formatted).toContain('TS2345');
    expect(formatted).toContain('LINT');
    expect(formatted).toContain('WARNING');
    // Should NOT contain the passing gate
    expect(formatted).not.toContain('TESTS');
  });

  // ─── Context Gatherer Integration ───────────────────────────────

  it('gathers workspace snapshot from a real project', async () => {
    const snapshot = await gatherWorkspaceSnapshot(projectDir, 'greeting function');

    expect(snapshot.projectName).toBe('test-project');
    expect(snapshot.language).toBe('javascript'); // no tsconfig in this mini project
    expect(snapshot.fileTree).toContain('src/index.ts');
    expect(snapshot.packageJson).toContain('test-project');
  });

  it('formats snapshot for LLM prompt', async () => {
    const snapshot = await gatherWorkspaceSnapshot(projectDir);
    const prompt = formatSnapshotForPrompt(snapshot);

    expect(prompt).toContain('## Project Context');
    expect(prompt).toContain('test-project');
    expect(prompt).toContain('## File Tree');
    expect(prompt).toContain('## package.json');
  });

  // ─── State Persistence ──────────────────────────────────────────

  it('persists and recovers state across manager instances', async () => {
    const state1 = new StateManager(projectDir);
    state1.initWorkflow('Build auth module');
    state1.setSubtasks([
      { id: 'a', description: 'Create user model' },
      { id: 'b', description: 'Add password hashing' },
      { id: 'c', description: 'Create login endpoint' },
    ]);
    state1.updateSubtask('a', { status: 'completed', tests_written: true, code_implemented: true });
    state1.updateSubtask('b', { status: 'in_progress', attempts: 2 });

    // New instance reads from disk
    const state2 = new StateManager(projectDir);
    expect(state2.getState().original_request).toBe('Build auth module');
    expect(state2.getSubtask('a')?.status).toBe('completed');
    expect(state2.getSubtask('b')?.status).toBe('in_progress');
    expect(state2.getSubtask('c')?.status).toBe('pending');

    // Simulate resume — reset interrupted tasks
    const resetCount = state2.resetInterruptedTasks();
    expect(resetCount).toBe(1);
    expect(state2.getSubtask('b')?.status).toBe('pending');

    // Next pending should be 'b' (was reset from in_progress)
    const next = state2.getNextPendingTask();
    expect(next?.id).toBe('b');
  });

  // ─── Full Pipeline Simulation ───────────────────────────────────

  it('simulates a complete subtask lifecycle: sandbox → write → gate → merge', async () => {
    const state = new StateManager(projectDir);
    state.initWorkflow('Add math utils');
    state.setSubtasks([{ id: 'math-1', description: 'Create add function with tests' }]);

    const task = state.getNextPendingTask()!;
    state.updateSubtask(task.id, { status: 'in_progress', attempts: 1 });

    const sandbox = new Sandbox(projectDir);
    const originalBranch = await sandbox.getCurrentBranch();

    // Simulate implementation output (what the LLM would produce)
    await sandbox.createBranch(`tdd-workflow/${task.id}`);
    sandbox.writeFiles([
      {
        filepath: 'src/math.ts',
        content: 'export function add(a: number, b: number): number { return a + b; }\n',
      },
      {
        filepath: 'tests/math.test.js',
        content: [
          'import { describe, it } from "node:test";',
          'import assert from "node:assert";',
          '',
          'describe("add", () => {',
          '  it("adds two numbers", () => {',
          '    // Would import from src/math.ts in real project',
          '    assert.strictEqual(1 + 2, 3);',
          '  });',
          '});',
          '',
        ].join('\n'),
      },
    ]);

    await sandbox.commit(`TDD: ${task.description}`);

    // Verify files exist
    expect(fs.existsSync(path.join(projectDir, 'src/math.ts'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'tests/math.test.js'))).toBe(true);

    // Merge
    await sandbox.mergeAndCleanup(`tdd-workflow/${task.id}`, originalBranch);
    state.updateSubtask(task.id, { status: 'completed', tests_written: true, code_implemented: true });

    // Verify final state
    expect(state.getSubtask(task.id)?.status).toBe('completed');
    expect(state.getSummary().completed).toBe(1);
    expect(fs.existsSync(path.join(projectDir, 'src/math.ts'))).toBe(true);
  });

  // ─── Path Safety ────────────────────────────────────────────────

  it('prevents path traversal in the full pipeline', async () => {
    const sandbox = new Sandbox(projectDir);
    expect(() =>
      sandbox.writeFiles([
        { filepath: '../../../etc/evil.txt', content: 'bad stuff' },
      ])
    ).toThrow('Path traversal detected');
  });
});

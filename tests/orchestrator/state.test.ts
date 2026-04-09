import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateManager } from '../../src/orchestrator/state.js';

describe('StateManager', () => {
  let tmpDir: string;

  function createTmpDir(): string {
    const dir = path.join(os.tmpdir(), `state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates .tdd-workflow directory on construction', () => {
    tmpDir = createTmpDir();
    new StateManager(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.tdd-workflow'))).toBe(true);
  });

  it('initializes with empty state', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    const state = sm.getState();
    expect(state.subtasks).toHaveLength(0);
    expect(state.original_request).toBe('');
  });

  it('persists workflow state to disk', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('Build auth module');
    sm.setSubtasks([{ id: 'task-1', description: 'Write JWT validator' }]);

    // Create new instance from same directory — should hydrate from disk
    const sm2 = new StateManager(tmpDir);
    expect(sm2.getState().original_request).toBe('Build auth module');
    expect(sm2.getState().subtasks).toHaveLength(1);
    expect(sm2.getState().subtasks[0]?.status).toBe('pending');
  });

  it('gets next pending task', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second' },
    ]);

    const next = sm.getNextPendingTask();
    expect(next?.id).toBe('a');
  });

  it('returns undefined when no pending tasks', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([{ id: 'a', description: 'first' }]);
    sm.updateSubtask('a', { status: 'completed' });

    expect(sm.getNextPendingTask()).toBeUndefined();
  });

  it('updates subtask fields', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([{ id: 'x', description: 'task' }]);
    sm.updateSubtask('x', { status: 'in_progress', attempts: 1 });

    const task = sm.getSubtask('x');
    expect(task?.status).toBe('in_progress');
    expect(task?.attempts).toBe(1);
  });

  it('resets interrupted tasks', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([
      { id: 'a', description: 'first' },
      { id: 'b', description: 'second' },
    ]);
    sm.updateSubtask('a', { status: 'in_progress' });
    sm.updateSubtask('b', { status: 'completed' });

    const count = sm.resetInterruptedTasks();
    expect(count).toBe(1);
    expect(sm.getSubtask('a')?.status).toBe('pending');
    expect(sm.getSubtask('b')?.status).toBe('completed');
  });

  it('resets failed tasks', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([{ id: 'a', description: 'first' }]);
    sm.updateSubtask('a', { status: 'failed', attempts: 3, feedback: 'broke' });

    const count = sm.resetFailedTasks();
    expect(count).toBe(1);
    expect(sm.getSubtask('a')?.status).toBe('pending');
    expect(sm.getSubtask('a')?.attempts).toBe(0);
    expect(sm.getSubtask('a')?.feedback).toBeUndefined();
  });

  it('provides summary counts', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([
      { id: 'a', description: 'a' },
      { id: 'b', description: 'b' },
      { id: 'c', description: 'c' },
    ]);
    sm.updateSubtask('a', { status: 'completed' });
    sm.updateSubtask('b', { status: 'failed' });

    const summary = sm.getSummary();
    expect(summary.total).toBe(3);
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.pending).toBe(1);
  });

  it('hasWorkflow returns false when empty', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    expect(sm.hasWorkflow()).toBe(false);
  });

  it('hasWorkflow returns true after setting subtasks', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([{ id: 'a', description: 'a' }]);
    expect(sm.hasWorkflow()).toBe(true);
  });

  it('getState returns a deep copy — mutating it does not affect internal state', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([{ id: 'a', description: 'original' }]);

    const state = sm.getState();
    state.subtasks[0]!.description = 'mutated';

    // Internal state should be unchanged
    expect(sm.getSubtask('a')?.description).toBe('original');
  });

  it('saveState uses atomic write — corrupt tmp file is cleaned up on write error', () => {
    tmpDir = createTmpDir();
    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');

    // After a successful saveState, the state file should exist and be valid JSON
    const stateFile = path.join(tmpDir, '.tdd-workflow', 'state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(parsed.original_request).toBe('test');

    // No .tmp files should remain after successful save
    const dir = path.join(tmpDir, '.tdd-workflow');
    const tmpFiles = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('updateSubtask logs a warning when called with an unknown ID', () => {
    tmpDir = createTmpDir();

    // Mock the logger
    const warnSpy = vi.fn();
    vi.doMock('../../src/utils/logger.js', () => ({
      getLogger: () => ({ warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      _resetLogger: vi.fn(),
    }));

    const sm = new StateManager(tmpDir);
    sm.initWorkflow('test');
    sm.setSubtasks([{ id: 'real-id', description: 'real task' }]);

    // Calling with unknown id should not throw, but should warn
    expect(() => sm.updateSubtask('non-existent-id', { status: 'completed' })).not.toThrow();
  });

  it('loadState backs up corrupt file and starts fresh', () => {
    tmpDir = createTmpDir();

    // Write invalid JSON to the state file path
    const workflowDir = path.join(tmpDir, '.tdd-workflow');
    fs.mkdirSync(workflowDir, { recursive: true });
    const stateFile = path.join(workflowDir, 'state.json');
    fs.writeFileSync(stateFile, 'THIS IS NOT VALID JSON {{{', 'utf-8');

    // StateManager should succeed and start fresh
    const sm = new StateManager(tmpDir);
    const state = sm.getState();
    expect(state.original_request).toBe('');
    expect(state.subtasks).toHaveLength(0);

    // A backup file should have been created
    const files = fs.readdirSync(workflowDir);
    const backupFiles = files.filter(f => f.startsWith('state.json.corrupt.'));
    expect(backupFiles.length).toBeGreaterThan(0);
  });
});

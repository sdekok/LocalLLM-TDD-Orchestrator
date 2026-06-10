/**
 * Shared test harness for WorkflowExecutor suites — the parts that touch real
 * src classes (ModelRouter, StateManager, WorkflowExecutor). The module-mock
 * factories and the mock session live in executor-mocks.ts, which must stay
 * src-import-free because it is dynamically imported from inside hoisted
 * `vi.mock(...)` factories. This file is imported normally by test bodies, so it
 * is safe to import the real classes here.
 *
 * Re-exports the mock/session helpers so a test file can import everything it
 * needs from one place.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { WorkflowExecutor } from '../../src/orchestrator/executor.js';
import { StateManager } from '../../src/orchestrator/state.js';
import { ModelRouter } from '../../src/llm/model-router.js';

export {
  plannerMock,
  execMock,
  qualityGatesMock,
  epicLoaderMock,
  subagentFactoryMock,
  sandboxMock,
  sandboxSingleton,
  makeMockSession,
  makeMessageUpdateEvent,
} from './executor-mocks.js';

export function makeModelRouter(): ModelRouter {
  return new ModelRouter({
    models: {
      'test-model': {
        name: 'Test',
        ggufFilename: 'test.gguf',
        provider: 'local',
        contextWindow: 8192,
        maxOutputTokens: 1024,
        architecture: 'dense',
        speed: 'fast',
        enableThinking: false,
      },
    },
    routing: { plan: 'test-model', implement: 'test-model', review: 'test-model' },
  });
}

export interface ExecutorContext {
  projectDir: string;
  state: StateManager;
  executor: WorkflowExecutor;
  /** Remove the temp project dir. */
  cleanup(): void;
}

/**
 * Mint a throwaway project dir, StateManager, and WorkflowExecutor wired to a
 * test ModelRouter. Pass `chatMessage` (or other callbacks) through `callbacks`.
 */
export function makeExecutorContext(
  prefix = 'exec-test-',
  callbacks?: Record<string, unknown>,
): ExecutorContext {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const state = new StateManager(projectDir);
  const executor = new WorkflowExecutor(state, makeModelRouter(), callbacks as any);
  return {
    projectDir,
    state,
    executor,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

/**
 * Replace global.setTimeout with one that ignores the requested delay and fires
 * on the next tick. Eliminates the executor's slot-recovery sleeps so resume /
 * processQueue tests finish fast. Returns a restore function.
 */
export function installImmediateSetTimeout(): () => void {
  const realSetTimeout = global.setTimeout;
  const fakeSetTimeout = (fn: (...args: any[]) => void, _delay?: number, ...args: any[]) => {
    return realSetTimeout(fn, 0, ...args);
  };
  (global as any).setTimeout = fakeSetTimeout;
  return () => {
    (global as any).setTimeout = realSetTimeout;
  };
}

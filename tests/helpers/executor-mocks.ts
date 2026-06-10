/**
 * Module-mock factories + the controllable mock session, for WorkflowExecutor
 * suites. CRITICAL: this file imports NOTHING from src/. The `vi.mock` factories
 * below are dynamically imported from inside each test file's hoisted
 * `vi.mock(...)` calls, so any transitive src import here would pull a
 * being-mocked module back into mock resolution and risk a circular load.
 * Keep this file dependency-free apart from Vitest.
 *
 * Usage in a test file:
 *
 *   vi.mock('../../src/orchestrator/sandbox.js', async () =>
 *     (await import('../helpers/executor-mocks.js')).sandboxMock());
 *
 * The async factory + dynamic import sidesteps `vi.mock`'s hoisting-reference
 * restriction. Because every file shares this one module instance, mutable
 * singletons (the sandbox) are shared between the mock and the assertions.
 */
import { vi } from 'vitest';

export function plannerMock() {
  return { planAndBreakdown: vi.fn() };
}

export function execMock() {
  return {
    execFileAsync: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    DEFAULT_MAX_BUFFER: 10 * 1024 * 1024,
  };
}

export function qualityGatesMock() {
  return {
    runQualityGates: vi.fn(),
    collectCoverageSnapshot: vi.fn().mockResolvedValue(undefined),
    detectTestCommand: vi.fn(),
    formatGateFailures: vi.fn(),
    hasCoverageThresholds: vi.fn().mockReturnValue(false),
  };
}

export function epicLoaderMock() {
  return {
    EpicLoader: vi.fn().mockImplementation(function () {
      return {
        findEpic: vi.fn().mockReturnValue(null),
        parseEpic: vi.fn(),
      };
    }),
  };
}

export function subagentFactoryMock() {
  return { createSubAgentSession: vi.fn() };
}

/**
 * Shared sandbox singleton. The executor calls `new Sandbox()` many times but the
 * mock always returns this one instance, so a test can both drive behaviour (e.g.
 * `getCurrentBranch.mockResolvedValue(...)`) and assert on it (`rollback` called)
 * by importing this module.
 */
export const sandboxSingleton = {
  createBranch: vi.fn(async () => undefined),
  getCurrentBranch: vi.fn(async () => 'main'),
  safeCheckout: vi.fn(async () => undefined),
  ensureOnBaseBranch: vi.fn(async (b?: string) => b ?? 'main'),
  rollback: vi.fn(async () => undefined),
  mergeAndCleanup: vi.fn(async () => undefined),
  commit: vi.fn(async () => undefined),
};

export function sandboxMock() {
  // Plain constructor function so `new Sandbox()` works under Vitest's mock hoisting.
  function MockSandbox() {
    return sandboxSingleton;
  }
  return { Sandbox: MockSandbox };
}

/**
 * Creates a minimal mock session with a controllable subscribe listener.
 * Returns the session mock and a helper to fire session events.
 */
export function makeMockSession() {
  // Support multiple concurrent subscribers like a real session — the executor
  // keeps the implementer handle subscribed across attempts while the reviewer
  // subscribes/unsubscribes on the same (sometimes shared) session. A single
  // listener would be clobbered by the reviewer, so the implementer's events
  // would vanish on retries.
  const listeners: Array<(event: any) => void> = [];
  const session = {
    subscribe: vi.fn((fn: (event: any) => void) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    }),
    // Emit one benign activity event per turn before resolving. A real session
    // always streams at least one event when the model responds; without this
    // the executor's "model produced no response" fast-fail (ModelUnreachableError)
    // would correctly treat a silent mock as an unreachable endpoint and halt.
    // tool_execution_start sets modelActivitySeen without touching turnText or
    // chatMessage, so it preserves every existing assertion.
    prompt: vi.fn(async () => {
      for (const l of [...listeners]) l({ type: 'tool_execution_start', toolName: 'read', args: { path: 'x.ts' } });
    }),
    dispose: vi.fn(),
    messages: [],
  };
  const fire = (event: any) => {
    for (const l of [...listeners]) l(event);
  };
  return { session, fire };
}

export function makeMessageUpdateEvent(ae: Record<string, unknown>) {
  return { type: 'message_update', assistantMessageEvent: ae };
}

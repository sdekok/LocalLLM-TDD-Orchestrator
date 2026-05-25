import { describe, it, expect } from 'vitest';
import { pruneContextMessages } from '../../src/subagent/factory.js';

function user(content: any) {
  return { role: 'user', content };
}
function assistant(...blocks: any[]) {
  return { role: 'assistant', content: blocks };
}
function text(t: string) {
  return { type: 'text', text: t };
}
function toolUse(name: string, input: any = {}) {
  return { type: 'tool_use', name, input };
}
function toolResult(content: any) {
  return { type: 'tool_result', content };
}

const BIG = 'x'.repeat(40_000); // ~10_000 tokens by char/4 heuristic

describe('pruneContextMessages', () => {
  it('is a no-op when under budget', () => {
    const messages = [
      user('hello'),
      assistant(text('hi')),
      user('bye'),
    ];
    const { messages: out, stats } = pruneContextMessages(messages, 100_000);
    expect(out).toBe(messages);
    expect(stats.stubbedBlocks).toBe(0);
  });

  it('stubs oldest tool_result first when over budget', () => {
    const messages = [
      user('start'),
      assistant(toolUse('bash', { cmd: 'pnpm test' })),
      user([toolResult(BIG)]), // old, huge
      assistant(text('working on it')),
      user('next'),
      assistant(toolUse('read', { path: 'a.ts' })),
      user([toolResult(BIG)]), // recent, huge — kept
      assistant(text('almost done')),
    ];
    const { messages: out, stats } = pruneContextMessages(messages, 5_000, 4);
    expect(stats.stubbedBlocks).toBeGreaterThanOrEqual(1);
    // Old tool_result (index 2) should be stubbed
    expect(out[2].content[0].content).toMatch(/elided by context pruner/);
    // Recent tool_result (index 6) — within last 4 messages — should be untouched
    expect(out[6].content[0].content).toBe(BIG);
  });

  it('preserves the last keepRecentMessages verbatim', () => {
    const messages = [
      user([toolResult(BIG)]),
      assistant(text('a')),
      user([toolResult(BIG)]),
      assistant(text('b')),
      user([toolResult(BIG)]),
      assistant(text('c')),
    ];
    const { messages: out } = pruneContextMessages(messages, 100, 2);
    // Last 2 messages preserved
    expect(out[5].content[0].text).toBe('c');
    expect(out[4].content[0].content).toBe(BIG);
    // Older messages should have stubs
    expect(out[0].content[0].content).toMatch(/elided/);
  });

  it('does not mutate the input messages', () => {
    const big = toolResult(BIG);
    const orig = user([big]);
    const messages = [orig, assistant(text('a')), user('b'), assistant(text('c')), user('d')];
    pruneContextMessages(messages, 100, 2);
    expect(orig.content[0].content).toBe(BIG);
  });

  it('stops once total is back under budget', () => {
    // Three big results, but budget allows ~1 to survive.
    const messages = [
      user([toolResult(BIG)]),
      assistant(text('a')),
      user([toolResult(BIG)]),
      assistant(text('b')),
      user([toolResult(BIG)]),
      assistant(text('c')),
      user('d'), // kept
      assistant(text('e')), // kept
    ];
    const { stats } = pruneContextMessages(messages, 11_000, 2);
    // Should have stubbed at least 2 of the 3 old tool_results (each ~10k tok)
    expect(stats.stubbedBlocks).toBeGreaterThanOrEqual(2);
    expect(stats.totalAfter).toBeLessThanOrEqual(stats.totalBefore);
  });

  it('also stubs tool_use input if still over after tool_result pass', () => {
    const messages = [
      assistant(toolUse('write', { path: 'x.ts', content: BIG })),
      user('ack'),
      assistant(text('done')),
      user('next'),
    ];
    const { messages: out, stats } = pruneContextMessages(messages, 100, 2);
    expect(stats.stubbedBlocks).toBeGreaterThanOrEqual(1);
    expect(out[0].content[0].input).toEqual({ __pruned: true });
  });

  it('handles messages with string content', () => {
    const messages = [
      user('a'.repeat(40_000)),
      user('b'.repeat(40_000)),
      user('keep this'),
      assistant(text('reply')),
    ];
    // No tool_result/tool_use blocks to stub — total stays above budget, but
    // the pruner only touches block-shaped content, not plain strings. So
    // stubbedBlocks=0 and the messages come back unchanged.
    const { messages: out, stats } = pruneContextMessages(messages, 100, 2);
    expect(stats.stubbedBlocks).toBe(0);
    expect(out).toBe(messages);
  });

  it('handles tool_result with array content (text blocks)', () => {
    const messages = [
      user([toolResult([{ type: 'text', text: BIG }])]),
      assistant(text('a')),
      user('b'),
      assistant(text('c')),
    ];
    const { messages: out, stats } = pruneContextMessages(messages, 100, 2);
    expect(stats.stubbedBlocks).toBe(1);
    expect(out[0].content[0].content).toMatch(/elided/);
  });

  it('does not prune when message count <= keepRecentMessages', () => {
    const messages = [
      user([toolResult(BIG)]),
      assistant(text('a')),
    ];
    const { messages: out, stats } = pruneContextMessages(messages, 100, 4);
    expect(stats.stubbedBlocks).toBe(0);
    expect(out).toBe(messages);
  });
});

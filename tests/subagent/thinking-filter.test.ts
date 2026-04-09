import { describe, it, expect } from 'vitest';
import { stripThinkingFromHistory } from '../../src/subagent/factory.js';

// Helper to build a minimal assistant message with content blocks
function assistant(...blocks: Array<{ type: string; [k: string]: any }>) {
  return { role: 'assistant', content: blocks };
}

function user(text: string) {
  return { role: 'user', content: text };
}

function thinking(text: string) {
  return { type: 'thinking', thinking: text };
}

function text(t: string) {
  return { type: 'text', text: t };
}

function toolCall(name: string) {
  return { type: 'tool_call', name };
}

describe('stripThinkingFromHistory', () => {
  it('strips thinking from earlier assistant messages but keeps the last', () => {
    const messages = [
      user('hello'),
      assistant(thinking('step 1'), text('answer 1')),
      user('follow up'),
      assistant(thinking('step 2'), text('answer 2')),
    ];

    const result = stripThinkingFromHistory(messages);

    // First assistant: thinking stripped
    expect(result[1].content).toEqual([text('answer 1')]);
    // Last assistant: thinking preserved
    expect(result[3].content).toEqual([thinking('step 2'), text('answer 2')]);
  });

  it('preserves thinking when there is only one assistant message', () => {
    const messages = [
      user('hello'),
      assistant(thinking('my thoughts'), text('my answer')),
    ];

    const result = stripThinkingFromHistory(messages);

    expect(result[1].content).toEqual([thinking('my thoughts'), text('my answer')]);
  });

  it('handles messages with no assistant messages', () => {
    const messages = [user('hello'), user('world')];

    const result = stripThinkingFromHistory(messages);

    expect(result).toEqual(messages);
  });

  it('handles empty message array', () => {
    expect(stripThinkingFromHistory([])).toEqual([]);
  });

  it('does not modify user messages', () => {
    const messages = [
      user('hello'),
      assistant(thinking('think'), text('reply')),
      user('follow up'),
      assistant(text('reply 2')),
    ];

    const result = stripThinkingFromHistory(messages);

    expect(result[0]).toEqual(user('hello'));
    expect(result[2]).toEqual(user('follow up'));
  });

  it('preserves non-thinking content blocks (text, tool_call)', () => {
    const messages = [
      user('hello'),
      assistant(thinking('think'), text('visible'), toolCall('read')),
      user('next'),
      assistant(thinking('think 2'), text('answer')),
    ];

    const result = stripThinkingFromHistory(messages);

    // First assistant: thinking stripped, text and tool_call kept
    expect(result[1].content).toEqual([text('visible'), toolCall('read')]);
  });

  it('strips thinking from multiple earlier assistant messages', () => {
    const messages = [
      user('q1'),
      assistant(thinking('t1'), text('a1')),
      user('q2'),
      assistant(thinking('t2'), text('a2')),
      user('q3'),
      assistant(thinking('t3'), text('a3')),
    ];

    const result = stripThinkingFromHistory(messages);

    // First two assistants: thinking stripped
    expect(result[1].content).toEqual([text('a1')]);
    expect(result[3].content).toEqual([text('a2')]);
    // Last assistant: thinking preserved
    expect(result[5].content).toEqual([thinking('t3'), text('a3')]);
  });

  it('handles assistant messages without thinking blocks (no-op)', () => {
    const messages = [
      user('hello'),
      assistant(text('no thinking here')),
      user('next'),
      assistant(text('also no thinking')),
    ];

    const result = stripThinkingFromHistory(messages);

    expect(result[1].content).toEqual([text('no thinking here')]);
    expect(result[3].content).toEqual([text('also no thinking')]);
  });

  it('does not mutate the original messages', () => {
    const original = assistant(thinking('secret'), text('visible'));
    const messages = [user('hi'), original, user('next'), assistant(text('last'))];

    stripThinkingFromHistory(messages);

    // Original message should be unchanged
    expect(original.content).toEqual([thinking('secret'), text('visible')]);
  });
});

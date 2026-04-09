import { describe, it, expect } from 'vitest';
import { extractOutermostJSON, extractPlanFromResponse } from '../../../src/agents/components/response-extractor.js';
import { InvalidJsonError } from '../../../src/agents/errors/planner-errors.js';

describe('extractOutermostJSON', () => {
  it('returns first valid balanced JSON object', () => {
    const text = 'Some text {"key": "value"} more text';
    const result = extractOutermostJSON(text);
    expect(result).toBe('{"key": "value"}');
  });

  it('skips invalid first object and returns valid second one', () => {
    // First { ... } candidate has bare/unquoted key — fails JSON.parse, so we keep scanning
    const text = '{bad json here} {"good": "json"}';
    const result = extractOutermostJSON(text);
    expect(result).toBe('{"good": "json"}');
  });

  it('returns null if no valid JSON found', () => {
    const text = 'no json here at all';
    expect(extractOutermostJSON(text)).toBeNull();
  });

  it('returns null when all candidates are invalid JSON', () => {
    const text = '{bad} {also bad}';
    expect(extractOutermostJSON(text)).toBeNull();
  });

  it('handles nested objects correctly', () => {
    const text = 'prefix {"outer": {"inner": 42}} suffix';
    const result = extractOutermostJSON(text);
    expect(result).toBe('{"outer": {"inner": 42}}');
    expect(JSON.parse(result!)).toEqual({ outer: { inner: 42 } });
  });
});

describe('extractPlanFromResponse', () => {
  const validPlan = {
    reasoning: 'step by step',
    summary: 'test summary',
    epics: [
      {
        title: 'Epic 1',
        slug: 'epic-1',
        description: 'Epic description',
        workItems: [
          {
            id: 'WI-1',
            title: 'Work Item 1',
            description: 'Do something',
            acceptance: ['criterion 1'],
            tests: ['test case 1'],
          },
        ],
      },
    ],
    architecturalDecisions: ['decision 1'],
  };

  it('uses bracket-balanced extraction (handles multiple JSON objects)', () => {
    // Put an invalid JSON object first, then the valid plan
    const text = `{bad json}\n${JSON.stringify(validPlan)}`;
    const result = extractPlanFromResponse(text);
    expect(result.summary).toBe('test summary');
    expect(result.epics).toHaveLength(1);
  });

  it('extracts plan from markdown code block', () => {
    const text = `Here is the plan:\n\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``;
    const result = extractPlanFromResponse(text);
    expect(result.summary).toBe('test summary');
  });

  it('throws InvalidJsonError when no valid JSON found', () => {
    expect(() => extractPlanFromResponse('no json here')).toThrow(InvalidJsonError);
  });
});

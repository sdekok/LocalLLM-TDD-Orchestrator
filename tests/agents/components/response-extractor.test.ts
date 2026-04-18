import { describe, it, expect } from 'vitest';
import { extractOutermostJSON, extractPlanFromResponse, normalizeJsonQuotes, TruncatedJsonError } from '../../../src/agents/components/response-extractor.js';
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

  it('throws TruncatedJsonError when outermost object is never closed', () => {
    const text = '{"reasoning": "thinking...", "summary": "A design system';
    expect(() => extractOutermostJSON(text)).toThrow(TruncatedJsonError);
  });

  it('TruncatedJsonError includes the partial content', () => {
    const text = '{"key": "val';
    let err: TruncatedJsonError | undefined;
    try { extractOutermostJSON(text); } catch (e) { err = e as TruncatedJsonError; }
    expect(err).toBeInstanceOf(TruncatedJsonError);
    expect(err!.partial).toContain('"key"');
  });

  it('handles nested objects correctly', () => {
    const text = 'prefix {"outer": {"inner": 42}} suffix';
    const result = extractOutermostJSON(text);
    expect(result).toBe('{"outer": {"inner": 42}}');
    expect(JSON.parse(result!)).toEqual({ outer: { inner: 42 } });
  });

  it('normalizes curly/smart quotes and returns valid JSON', () => {
    // Model emitted \u201C/\u201D double curly quotes outside a code block
    const text = 'Here is the result: {\u201Ckey\u201D: \u201Cvalue\u201D}';
    const result = extractOutermostJSON(text);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ key: 'value' });
  });

  it('normalizes curly quotes in nested objects', () => {
    const text = '{\u201Couter\u201D: {\u201Cinner\u201D: 42}}';
    const result = extractOutermostJSON(text);
    expect(result).not.toBeNull();
    expect(JSON.parse(result!)).toEqual({ outer: { inner: 42 } });
  });
});

describe('extractPlanFromResponse', () => {
  const validPlan = {
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

  it('accepts a plan without reasoning field', () => {
    const planNoReasoning = { ...validPlan };
    const result = extractPlanFromResponse(JSON.stringify(planNoReasoning));
    expect(result.summary).toBe('test summary');
    expect(result.reasoning).toBeUndefined();
  });

  it('throws TruncatedJsonError when the plan JSON is cut off', () => {
    const truncated = '{"summary": "A design system", "epics": [{"title": "E1", "slug": "e1"';
    expect(() => extractPlanFromResponse(truncated)).toThrow(TruncatedJsonError);
  });

  it('parses plan when model uses curly/smart quotes in code block', () => {
    const raw = `{\u201Csummary\u201D: \u201Ctest summary\u201D, \u201Cepics\u201D: [], \u201CarchitecturalDecisions\u201D: []}`;
    const normalized = normalizeJsonQuotes(raw);
    expect(JSON.parse(normalized)).toMatchObject({ summary: 'test summary' });
  });

  it('parses plan with curly quotes outside a code block (bracket-balanced path)', () => {
    // This is the path that was previously broken — curly quotes outside a
    // code block go through extractOutermostJSON, which now normalizes first.
    const raw = `Here is your plan: {\u201Csummary\u201D: \u201Ctest summary\u201D, \u201Cepics\u201D: [{\u201Ctitle\u201D: \u201CEpic 1\u201D, \u201Cslug\u201D: \u201Cepic-1\u201D, \u201Cdescription\u201D: \u201CDesc\u201D, \u201CworkItems\u201D: [{\u201Cid\u201D: \u201CWI-1\u201D, \u201Ctitle\u201D: \u201CTask\u201D, \u201Cdescription\u201D: \u201CDo thing\u201D, \u201Cacceptance\u201D: [\u201Cdone\u201D], \u201Ctests\u201D: [\u201Ctest\u201D]}]}], \u201CarchitecturalDecisions\u201D: []}`;
    const result = extractPlanFromResponse(raw);
    expect(result.summary).toBe('test summary');
    expect(result.epics).toHaveLength(1);
  });
});

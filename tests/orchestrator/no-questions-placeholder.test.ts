import { describe, it, expect } from 'vitest';
import { isNoQuestionsPlaceholder } from '../../src/orchestrator/executor.js';

describe('isNoQuestionsPlaceholder', () => {
  // Cases observed in the wild — must all be filtered.
  it.each([
    '(No questions — all acceptance criteria met.)',
    '(No questions - all acceptance criteria met.)',
    'No questions.',
    'No questions',
    'no questions',
    'No remaining questions.',
    'N/A',
    'n/a',
    'None',
    'none',
    'Nothing to ask',
    'Nothing.',
    '- (none)',
    '1. n/a',
    '* None',
    'All acceptance criteria met.',
    'All criteria satisfied',
    'No blockers',
    'No ambiguities',
    '   ',
    '',
  ])('treats %j as no-questions', (input) => {
    expect(isNoQuestionsPlaceholder(input)).toBe(true);
  });

  // Real questions — must NOT be filtered.
  it.each([
    '1. Should we use PostgreSQL or MySQL? Assumption: PostgreSQL.',
    'Q: Which auth library? I assumed Auth.js.',
    '- Should the column be nullable?',
    'No clear answer in the codebase — should I use option A or B?',
    'I have one question: which version of React?',
  ])('treats %j as a real question', (input) => {
    expect(isNoQuestionsPlaceholder(input)).toBe(false);
  });
});

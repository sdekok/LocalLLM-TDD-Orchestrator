import { describe, it, expect } from 'vitest';
import { shouldRefreshSession } from '../../src/orchestrator/executor.js';

const base = {
  attempt: 3,
  feedbackRounds: 2,
  lastPromptTokens: 0,
  refreshTokenThreshold: 131_072,
  refreshAfterRounds: 2,
};

describe('shouldRefreshSession', () => {
  it('never refreshes on the first attempt', () => {
    expect(shouldRefreshSession({ ...base, attempt: 1, lastPromptTokens: 999_999 }).refresh).toBe(false);
  });

  it('never refreshes when there is no feedback yet', () => {
    expect(shouldRefreshSession({ ...base, feedbackRounds: 0, lastPromptTokens: 999_999 }).refresh).toBe(false);
  });

  it('refreshes on tokens when the prompt size crosses the threshold', () => {
    const r = shouldRefreshSession({ ...base, lastPromptTokens: 140_000 });
    expect(r).toEqual({ refresh: true, reason: 'tokens' });
  });

  it('does NOT refresh below the token threshold, even on a round-cadence attempt', () => {
    // attempt 3 with refreshAfterRounds=2 would have refreshed under the old
    // round-based rule; with usage data available the tokens govern.
    const r = shouldRefreshSession({ ...base, attempt: 3, lastPromptTokens: 40_000 });
    expect(r).toEqual({ refresh: false, reason: null });
  });

  it('refreshes by tokens even off the round cadence (one heavy thinking round)', () => {
    const r = shouldRefreshSession({ ...base, attempt: 2, lastPromptTokens: 200_000 });
    expect(r).toEqual({ refresh: true, reason: 'tokens' });
  });

  it('falls back to round cadence when the provider reports no usage', () => {
    expect(shouldRefreshSession({ ...base, attempt: 3, lastPromptTokens: 0 }))
      .toEqual({ refresh: true, reason: 'rounds' });
    expect(shouldRefreshSession({ ...base, attempt: 4, lastPromptTokens: 0 }))
      .toEqual({ refresh: false, reason: null });
    expect(shouldRefreshSession({ ...base, attempt: 5, lastPromptTokens: 0 }))
      .toEqual({ refresh: true, reason: 'rounds' });
  });

  it('exactly at the threshold counts as over', () => {
    const r = shouldRefreshSession({ ...base, lastPromptTokens: base.refreshTokenThreshold });
    expect(r.refresh).toBe(true);
  });
});

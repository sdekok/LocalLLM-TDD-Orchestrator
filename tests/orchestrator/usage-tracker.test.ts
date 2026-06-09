import { describe, it, expect } from 'vitest';
import { UsageTracker, formatDuration } from '../../src/orchestrator/usage-tracker.js';

describe('formatDuration', () => {
  it('formats seconds', () => expect(formatDuration(42_000)).toBe('42s'));
  it('formats minutes + seconds', () => expect(formatDuration(125_000)).toBe('2m05s'));
  it('formats hours + minutes', () => expect(formatDuration(3_725_000)).toBe('1h02m'));
});

describe('UsageTracker', () => {
  it('reports no data before anything is recorded', () => {
    const t = new UsageTracker();
    expect(t.hasData()).toBe(false);
    expect(t.summaryLine()).toBe('');
  });

  it('accumulates usage per role', () => {
    const t = new UsageTracker();
    t.record('implementer', { input: 1000, output: 200 });
    t.record('implementer', { input: 500, output: 100 });
    t.record('reviewer', { input: 2000, output: 50 });
    const totals = t.totals();
    expect(totals).toMatchObject({ calls: 3, input: 3500, output: 350 });
  });

  it('ignores undefined usage and missing fields', () => {
    const t = new UsageTracker();
    t.record('implementer', undefined);
    expect(t.hasData()).toBe(false);
    t.record('implementer', {});
    expect(t.totals()).toMatchObject({ calls: 1, input: 0, output: 0 });
  });

  it('produces a summary line with per-role call counts', () => {
    const t = new UsageTracker();
    t.record('implementer', { input: 31_420, output: 8_112 });
    t.record('implementer', { input: 100, output: 10 });
    t.record('reviewer', { input: 5_000, output: 400 });
    const line = t.summaryLine();
    expect(line).toContain('36,520 in / 8,522 out tokens');
    expect(line).toContain('3 calls');
    expect(line).toContain('implementer 2');
    expect(line).toContain('reviewer 1');
  });

  it('includes cache-read tokens when present', () => {
    const t = new UsageTracker();
    t.record('implementer', { input: 100, output: 10, cacheRead: 9_000 });
    expect(t.summaryLine()).toContain('(+9,000 cached)');
  });
});

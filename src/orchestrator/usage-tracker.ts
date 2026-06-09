/**
 * Structural subset of the Pi SDK's per-message `Usage` — defined locally so the
 * orchestrator doesn't reach into the SDK's nested pi-ai package for the type.
 */
export interface LlmUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface RoleUsage {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
}

/** Format a millisecond duration as "Xs" / "XmYYs" / "XhYYm". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, '0')}m`;
}

/**
 * Accumulates LLM token usage + wall time, broken down by agent role
 * (implementer / reviewer / arbiter / …). One tracker per task plus one for the
 * whole workflow; `subscribeToSession` records each assistant message's usage
 * into every active tracker.
 */
export class UsageTracker {
  private readonly startedAt = Date.now();
  private readonly roles = new Map<string, RoleUsage>();

  record(role: string, usage: LlmUsageLike | undefined): void {
    if (!usage) return;
    const entry = this.roles.get(role) ?? { calls: 0, input: 0, output: 0, cacheRead: 0 };
    entry.calls += 1;
    entry.input += usage.input ?? 0;
    entry.output += usage.output ?? 0;
    entry.cacheRead += usage.cacheRead ?? 0;
    this.roles.set(role, entry);
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  hasData(): boolean {
    return this.roles.size > 0;
  }

  totals(): RoleUsage {
    const total: RoleUsage = { calls: 0, input: 0, output: 0, cacheRead: 0 };
    for (const r of this.roles.values()) {
      total.calls += r.calls;
      total.input += r.input;
      total.output += r.output;
      total.cacheRead += r.cacheRead;
    }
    return total;
  }

  /**
   * One-line summary, e.g.
   * "31,420 in / 8,112 out tokens · 14 calls (implementer 10, reviewer 4) · 12m03s"
   * Returns empty string when nothing was recorded.
   */
  summaryLine(): string {
    if (!this.hasData()) return '';
    const t = this.totals();
    const perRole = [...this.roles.entries()]
      .map(([role, r]) => `${role} ${r.calls}`)
      .join(', ');
    const cache = t.cacheRead > 0 ? ` (+${t.cacheRead.toLocaleString()} cached)` : '';
    return `${t.input.toLocaleString()} in / ${t.output.toLocaleString()} out tokens${cache} · ` +
      `${t.calls} call${t.calls === 1 ? '' : 's'} (${perRole}) · ${formatDuration(this.elapsedMs)}`;
  }
}

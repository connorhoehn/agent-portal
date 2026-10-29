// Run limits — the decision (DE-37, docs/deployment-enhancements/DE-37-run-limits.md).
//
// Per-initiative, per-tenant and (optional) global limits on concurrency, runs
// per day and dollars per hour, judged inside lib/spend-holds.ts
// `reserveSpend` — after a pause and before the money gates — so every path
// that spends is limited the same way. Storage is providers/run-limits.ts.
//
// ── Decisions this encodes (recorded in the goal doc) ────────────────────────
// - A limit hit is a HARD refusal: 429 with Retry-After for a person, a
//   recorded skip for cron, back-to-queue (attempt unburned) for a job. There
//   is no confirm flag: limits protect the fleet's rate, not a forecast.
// - Absent row = no limit at that scope. No defaults are seeded, so today's
//   demo behaves as before; BOT_MAX_CONCURRENT stays the global bot-run
//   ceiling, and a `global` run_limits row (optional) adds a slot ceiling over
//   every path except box tasks.
// - Box tasks (`box_task`, `agent_loop`) take a slot at the INITIATIVE scope
//   only (when the box has one), never tenant or global: a person typing into
//   their own box is not blocked by a cron storm.
// - Only `orgiq` dispatches devbox work, so every run is charged to tenant
//   `orgiq` unless the caller names another.
// - `RUN_LIMITS=off` skips the whole judgement.

import type { RunLimitRow, RunScope, ScopeUsage } from '../providers/run-limits.js';

export type LimitKind = 'concurrency' | 'runs-per-day' | 'usd-per-hour';

export type RunLimitVerdict =
  | { kind: 'proceed' }
  | {
    kind: 'refuse'; scope: RunScope; limitKind: LimitKind; limit: number; current: number;
    reason: string; retryAfterS: number;
  };

export interface ScopeState {
  scope: RunScope;
  limit: RunLimitRow;
  usage: ScopeUsage;
  /** Whether this run takes a concurrency slot at this scope. */
  takesSlot: boolean;
}

export function runLimitsEnabled(): boolean {
  return (process.env['RUN_LIMITS'] ?? '').trim().toLowerCase() !== 'off';
}

function scopeName(s: RunScope): string {
  if (s.kind === 'initiative') return `initiative ${s.id}`;
  if (s.kind === 'tenant') return `the ${s.id} tenant`;
  return 'the fleet';
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Judge one run against every scope's limits, narrowest scope first, then by
 * kind: concurrency, runs per day, dollars per hour. Pure.
 */
export function decideRunLimits(states: readonly ScopeState[], amountUsd: number): RunLimitVerdict {
  const order: Record<RunScope['kind'], number> = { initiative: 0, tenant: 1, global: 2 };
  const sorted = [...states].sort((a, b) => order[a.scope.kind] - order[b.scope.kind]);
  for (const st of sorted) {
    const { limit, usage, scope } = st;
    if (st.takesSlot && limit.maxConcurrent != null && usage.liveSlots >= limit.maxConcurrent) {
      return {
        kind: 'refuse', scope, limitKind: 'concurrency', limit: limit.maxConcurrent, current: usage.liveSlots,
        reason: limit.maxConcurrent === 0
          ? `${scopeName(scope)} takes no new runs (its concurrency limit is 0)`
          : `${scopeName(scope)} is at its limit of ${limit.maxConcurrent} concurrent run${limit.maxConcurrent === 1 ? '' : 's'}; try again when one finishes`,
        retryAfterS: 30,
      };
    }
  }
  for (const st of sorted) {
    const { limit, usage, scope } = st;
    if (limit.maxRunsPerDay != null && usage.runsToday >= limit.maxRunsPerDay) {
      return {
        kind: 'refuse', scope, limitKind: 'runs-per-day', limit: limit.maxRunsPerDay, current: usage.runsToday,
        reason: `${scopeName(scope)} has used its ${limit.maxRunsPerDay} runs for the last 24 hours`,
        retryAfterS: 3600,
      };
    }
  }
  for (const st of sorted) {
    const { limit, usage, scope } = st;
    if (limit.maxUsdPerHour != null && usage.usdLastHour + amountUsd > limit.maxUsdPerHour) {
      return {
        kind: 'refuse', scope, limitKind: 'usd-per-hour', limit: limit.maxUsdPerHour,
        current: Math.round(usage.usdLastHour * 10_000) / 10_000,
        reason: `${scopeName(scope)} would pass its ${money(limit.maxUsdPerHour)} per hour limit (${money(usage.usdLastHour)} spent or held in the last hour, this run holds ${money(amountUsd)})`,
        retryAfterS: 600,
      };
    }
  }
  return { kind: 'proceed' };
}

/** Which scopes a run is judged at, and which of them it takes a slot in. */
export function scopesFor(input: {
  initiativeId: string | null; tenant: string; boxTask: boolean;
}): Array<{ scope: RunScope; takesSlot: boolean }> {
  const out: Array<{ scope: RunScope; takesSlot: boolean }> = [];
  if (input.initiativeId) out.push({ scope: { kind: 'initiative', id: input.initiativeId }, takesSlot: true });
  out.push({ scope: { kind: 'tenant', id: input.tenant }, takesSlot: !input.boxTask });
  out.push({ scope: { kind: 'global', id: '*' }, takesSlot: !input.boxTask });
  return out;
}

// The spend ledger, offline — `spend_entries` (schema/spend_ledger_schema.sql).
//
// Only the rows that have no other home are stored: job, box_task and
// agent_loop entries. A `bot_run` entry is DERIVED from the bot_runs fixture at
// read time (providers/spend-ledger.ts), never copied here, because a copy is
// right the day it is written and wrong the first time a run settles.
//
// Seeded: one finished ad-hoc task per seeded fleet computer (DE-31), because
// the seeded fleet (mock/devbox-fleet.ts) shows computers that have already
// worked, and a box's spend is a ledger read, not a stored total. Each entry
// takes its box, initiative, model and sender from the fleet row itself — the
// sender is the box's owner, the one person a seeded task can honestly name —
// so the only fact this file adds is the dollar figure. The unattributed box
// (no owner, no initiative) books to neither.
//
// Also seeded: three local compute runs, the ones the Halyard story's simulated reports describe
// (mock/run-report-fixtures.ts: the logout cookie run, the cutover plan run, the error-budget
// dashboard run), booked the way POST /api/local-compute/jobs/:id/complete books a local run: a
// confident $0 with provider `local`, and what the worker said the run cost kept beside it as
// `reportedUsd`. Without them Budgets > Lines opens on "$0 reported" until a worker has run.

import { clock, defineFixture } from './core/index.js';
import { seededFleet } from './devbox-fleet.js';
import type { SpendEntry } from '../providers/spend-ledger.js';

/** The one task each seeded computer finished before the demo opened, in dollars. */
const SEEDED_TASK_SPEND_USD: Readonly<Record<string, number>> = {
  'box-mock-0001': 2.41,
  'box-mock-0002': 1.86,
  'box-mock-0003': 0.74,
  'box-mock-0004': 0.38,
  'box-mock-0005': 0.12,
  'box-mock-0006': 0.53,
  'box-mock-0007': 1.12,
};

/** The machine that did the work: the operator's own, the one machine opted in to run jobs. */
const LOCAL_BOX = 'local:node-operator-thinkpad';

/**
 * What each local run reported it cost, in dollars: never billed, never counted against a cap
 * (nothing reads `reported_usd` as spend). Newest first; each is a few hours back, clamped so it
 * is always in the current month (the Lines report sums the calendar month).
 */
const SEEDED_LOCAL_RUNS: ReadonlyArray<{ job: string; initiativeId: string; reportedUsd: number; hoursAgo: number; tokens: [number, number] }> = [
  { job: 'job-local-seed-logout-cookie', initiativeId: 'p-auth-migration', reportedUsd: 0.46, hoursAgo: 3, tokens: [118_400, 9_200] },
  { job: 'job-local-seed-cutover-plan', initiativeId: 'p-auth-migration', reportedUsd: 0.31, hoursAgo: 6, tokens: [86_900, 6_100] },
  { job: 'job-local-seed-error-budget', initiativeId: 'p-observability', reportedUsd: 0.18, hoursAgo: 9, tokens: [41_300, 3_800] },
];

function seededLocalEntries(): SpendEntry[] {
  const now = Date.parse(clock.nowIso());
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return SEEDED_LOCAL_RUNS.map((r) => ({
    source: 'job' as const,
    sourceId: `${r.job}:1`,
    initiativeId: r.initiativeId,
    grantId: null,
    boxId: LOCAL_BOX,
    actorId: 'u-operator',
    trigger: null,
    model: 'claude-sonnet-5',
    costUsd: 0,
    costBasis: 'reported' as const,
    estimatedCostUsd: null,
    inputTokens: r.tokens[0],
    outputTokens: r.tokens[1],
    occurredAt: new Date(Math.max(monthStart, now - r.hoursAgo * 3_600_000)).toISOString(),
    provider: 'local' as const,
    reportedUsd: r.reportedUsd,
  }));
}

function seededEntries(): SpendEntry[] {
  return [...seededBoxEntries(), ...seededLocalEntries()];
}

function seededBoxEntries(): SpendEntry[] {
  return seededFleet().flatMap((box): SpendEntry[] => {
    const usd = SEEDED_TASK_SPEND_USD[box.id];
    if (usd == null) return [];
    // A minute after the box came up: inside its life, never before it.
    const at = box.createdAt ? new Date(Date.parse(box.createdAt) + 60_000).toISOString() : clock.nowIso();
    return [{
      source: 'box_task',
      sourceId: `${box.id}:seed-task-1`,
      initiativeId: box.projectId ?? null,
      grantId: null,
      boxId: box.id,
      actorId: box.ownerId ?? null,
      trigger: null,
      model: box.activeModel ?? null,
      costUsd: usd,
      costBasis: 'reported',
      estimatedCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      occurredAt: at,
      provider: 'bedrock',
    }];
  });
}

export const spendEntries = defineFixture<SpendEntry>({
  key: 'spend-entries',
  scenarios: {
    default: seededEntries,
    empty: () => [],
    error: () => { throw new Error('spend_entries unavailable: relation does not exist'); },
  },
});

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

function seededEntries(): SpendEntry[] {
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

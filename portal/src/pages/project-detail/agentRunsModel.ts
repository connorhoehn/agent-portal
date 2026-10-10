// The Agents tab's runs table: one row per agent run on the initiative, with
// the work item it served, the agent that ran it and what came of it. Pure —
// no DOM, no fetch — so node:test runs it.
//
// Every number here is counted from the rows it returns: the heading's spend
// is the sum of the listed runs' costs, never a stored total.

import type { BotRun } from '../bots/BotsPage';

export const RANGE_DAYS = [30, 90, 180] as const;

/** What a run with no work item is listed under — a bot's standing mission. */
export const NO_WORK_ITEM = 'No work item';
/** A run dispatched from a work item rather than by a bot. */
export const DISPATCHED_AGENT = 'Dispatched agent';

export interface RunTableRow {
  run: BotRun;
  workItemId: string | null;
  workItemLabel: string;
  agent: string;
  /** The run's outcome in words, or null when it recorded none. */
  outcome: string | null;
  startedMs: number;
}

const DAY_MS = 86_400_000;

export function startedMs(run: Pick<BotRun, 'startedAt'>): number {
  // Aurora stamps carry `+00`, which Date.parse rejects; normalise it.
  return Date.parse(run.startedAt.replace(' ', 'T').replace(/\+00$/, 'Z'));
}

function sentence(s: string | undefined): string | null {
  const t = s?.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

export function runTableRows(
  runs: readonly BotRun[],
  bots: ReadonlyArray<{ id: string; name: string }>,
  days: number,
  workTitles: ReadonlyMap<string, string>,
  now: number = Date.now(),
): { rows: RunTableRow[]; spendUsd: number } {
  const since = now - days * DAY_MS;
  const names = new Map(bots.map((b) => [b.id, b.name] as const));
  const rows = runs
    .map((run): RunTableRow => ({
      run,
      workItemId: run.workItemId,
      workItemLabel: run.workItemId ? workTitles.get(run.workItemId) ?? run.workItemId : NO_WORK_ITEM,
      agent: run.botId ? names.get(run.botId) ?? 'Bot' : DISPATCHED_AGENT,
      outcome: sentence(run.outcome?.summary) ?? sentence(run.outcome?.reason),
      startedMs: startedMs(run),
    }))
    .filter((r) => Number.isFinite(r.startedMs) && r.startedMs >= since)
    // Grouped by work item (runs with none last), newest first within each.
    .sort((a, b) => (a.workItemId ? 0 : 1) - (b.workItemId ? 0 : 1)
      || a.workItemLabel.localeCompare(b.workItemLabel)
      || b.startedMs - a.startedMs);
  const spendUsd = rows.reduce((sum, r) => sum + (r.run.costUsd ?? 0), 0);
  return { rows, spendUsd };
}

// Dispatched runs — the governed runs `/api/bots/active-runs` lists.
//
// Two different things on this site are called "runs", and the header said
// "2 running" while Automate › Runs said Running 0 about the same moment:
//
//   • QUEUE JOBS (`agent_jobs`, `/api/work/*`) — what "New run", a promoted
//     finding or a cron bot puts on the queue for the next idle computer.
//     The Runs table, its State chips and the Inbox's Current queue count
//     these.
//   • DISPATCHED RUNS (`bot_runs`, `/api/bots/active-runs`) — what ⚡ Estimate
//     → Authorize on an initiative's work item starts. It goes straight to a
//     computer and never touches the queue, so no queue count can include it.
//
// Both are real and both cost money; the defect was that each surface counted
// one and said nothing about the other. This module is the one place the
// dispatched kind is described, so the header badge and the Runs page name it
// the same way and send a click to the same place. Pure (no React) so
// `node --test` can load it.

/** One row of `GET /api/bots/active-runs` (routes/bots.ts). */
export interface DispatchedRun {
  id: string;
  workItemId: string | null;
  workItemTitle: string | null;
  projectId: string | null;
  trigger: string;
  startedAt: string;
  outcome?: { boxId?: string } | null;
}

export const ACTIVE_RUNS_URL = '/api/bots/active-runs';

/** Where the dispatched runs are listed in full, for every orgiq role. */
export const DISPATCHED_RUNS_PATH = '/iq/work/queue';

/** What the operator recognises a run by: the work item they dispatched, else
 *  "Marketplace work" for an item whose name was not found (its id goes behind a
 *  copy control, never the text: UX leftovers, 10 November), else the trigger
 *  for a run with no item behind it (a bot firing). */
export function dispatchedRunLabel(run: DispatchedRun): string {
  if (run.workItemTitle) return run.workItemTitle;
  if (run.workItemId) return 'Marketplace work';
  return run.trigger;
}

/**
 * Where selecting a dispatched run should go.
 *
 * Straight to the computer doing the work when the caller may open the lab
 * (`ManageDevbox`) — that is where the logs are tailed. Otherwise the work item
 * on its initiative, which every role that can dispatch can reach and which
 * carries the run's state and spend. A destination that bounces is worse than
 * none, so a run with neither falls back to the list of dispatched runs.
 */
export function dispatchedRunDestination(
  run: DispatchedRun,
  mayOpenLab: boolean,
): { path: string; kind: 'computer' | 'work-item' | 'list' } {
  const boxId = run.outcome?.boxId;
  if (mayOpenLab && boxId) return { path: `/admin/devbox?box=${encodeURIComponent(boxId)}`, kind: 'computer' };
  if (run.projectId && run.workItemId) {
    return {
      path: `/iq/projects/${encodeURIComponent(run.projectId)}?item=${encodeURIComponent(run.workItemId)}`,
      kind: 'work-item',
    };
  }
  return { path: DISPATCHED_RUNS_PATH, kind: 'list' };
}

/** "1 dispatched run" / "2 dispatched runs" — the noun both surfaces use. */
export function dispatchedRunsNoun(n: number): string {
  return `${n} dispatched run${n === 1 ? '' : 's'}`;
}

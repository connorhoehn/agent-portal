// Evidence (docs/learning-loop-design.md stage 5): what the runs said about
// the runbooks they were given, counted from run-report rows at read time and
// always shown with its sample size. Nothing here is stored; every number can
// be traced to the rows it lists. Pure: the rows, the window and the labels
// arrive as input.
//
//   given      the run's frozen brief offered it (RunReport.runbooksOffered)
//   followed   what the run SAID in its report's `runbooks` entry (yes / partly
//              / no; "unsaid" when it gave no entry for it — lane C adds the
//              entry, so older reports are all unsaid)
//   loaded     the session was seen loading it, or said `lab applied`
//              (RunReport.runbooksUsed): observed, not said
//   outcomes   how those runs ended
//
// A comparison of cost and duration against runs that were given no runbook is
// made only when both sides have at least COMPARE_MIN runs of work items that
// share a label; otherwise it says there are not enough runs to compare.
import type { RunOutcome, RunReport } from '../run-reports/types.js';

export const EVIDENCE_WINDOW_DAYS = 30;
export const COMPARE_MIN = 5;
const DAY_MS = 86_400_000;

export type Followed = 'yes' | 'partly' | 'no' | 'unsaid';

/** The run's own account of one runbook it was given (lane C's `runbooks` field), read tolerantly. */
export function followedOf(r: RunReport, runbookId: string): Followed {
  // The report stores the run's account as `runbookAccounts`; `runbooks` is the older spelling suites still build.
  const entries = r.runbookAccounts?.length ? r.runbookAccounts : (r as RunReport & { runbooks?: unknown }).runbooks;
  if (!Array.isArray(entries)) return 'unsaid';
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (o['id'] !== runbookId) continue;
    const f = o['followed'];
    return f === 'yes' || f === 'partly' || f === 'no' ? f : 'unsaid';
  }
  return 'unsaid';
}

const given = (r: RunReport, id: string) => r.runbooksOffered.some((o) => o.id === id);
const loaded = (r: RunReport, id: string) => r.runbooksUsed.some((u) => u.id === id);
const emptyOutcomes = (): Record<RunOutcome, number> => ({ done: 0, failed: 0, cancelled: 0, 'needs-review': 0 });

export interface EvidenceRun {
  runRef: string;
  workItemId: string | null;
  endedAt: string;
  outcome: RunOutcome;
  /** The version the brief gave, or null when it did not record one. */
  version: number | null;
  followed: Followed;
  loaded: boolean;
}

export interface SideFigures {
  runs: number;
  /** Median wall time of the runs that recorded a start, seconds; null when none did. */
  medianDurationS: number | null;
  /** Mean of the runs whose cost is money or a worker's report (never a simulated or unknown figure); null when none. */
  meanCostUsd: number | null;
  /** How many runs the cost mean is over. */
  costRuns: number;
}

export type Comparison =
  | { available: true; withRunbook: SideFigures; withoutRunbook: SideFigures; sharedLabels: string[] }
  | { available: false; reason: string; withRunbookRuns: number; withoutRunbookRuns: number };

export interface RunbookEvidence {
  runbookId: string;
  windowDays: number;
  since: string;
  /** Runs it was given to. */
  given: number;
  followed: Record<Followed, number>;
  /** Of the given runs, how many the session was seen loading it. */
  loaded: number;
  /** How the given runs ended. */
  outcomes: Record<RunOutcome, number>;
  /** Of the runs that said they followed it (yes or partly), how many ended done. */
  followedDone: number;
  /** The given runs, newest first. */
  runs: EvidenceRun[];
  comparison: Comparison;
}

export interface LoopEvidence {
  windowDays: number;
  since: string;
  /** Every run that reported in the window. */
  runs: number;
  /** Runs given at least one runbook. */
  runsGiven: number;
  /** Of those, runs that said they followed (yes or partly) at least one. */
  runsSaidFollowed: number;
  /** Of the runs that said they followed one, how many ended done. */
  runsSaidFollowedDone: number;
  /** Proposals filed by runs in the window, by status. */
  proposalsFromRuns: { total: number; open: number; accepted: number; rejected: number; merged: number; withdrawn: number };
  /** One row per runbook given in the window, most given first. */
  runbooks: Array<{ runbookId: string; given: number; saidFollowed: number; followedDone: number }>;
}

export const windowStart = (nowMs: number, days = EVIDENCE_WINDOW_DAYS): string => new Date(nowMs - days * DAY_MS).toISOString();

const inWindow = (rows: readonly RunReport[], since: string) => rows.filter((r) => r.endedAt >= since);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round(((s[m - 1]! + s[m]!) / 2) * 10) / 10;
}

function sideFigures(rows: RunReport[]): SideFigures {
  const durations = rows.flatMap((r) => (r.startedAt ? [Math.max(0, (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000)] : []))
    .filter((x) => Number.isFinite(x));
  const costs = rows.flatMap((r) => {
    if (r.cost.basis === 'billed' && r.cost.billedUsd !== null) return [r.cost.billedUsd];
    if (r.cost.basis === 'reported' && r.cost.reportedUsd !== null) return [r.cost.reportedUsd];
    return [];
  });
  return {
    runs: rows.length,
    medianDurationS: median(durations),
    meanCostUsd: costs.length ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 10_000) / 10_000 : null,
    costRuns: costs.length,
  };
}

/**
 * Runs given this runbook against runs given none, over work items that share a label with the
 * given runs' work items. `labelsOf` maps a work item id to its labels (null: unknown item).
 */
export function compareRuns(id: string, rows: readonly RunReport[], labelsOf: ReadonlyMap<string, string[]>): Comparison {
  const withR = rows.filter((r) => given(r, id) && r.workItemId && labelsOf.has(r.workItemId));
  const labels = new Set(withR.flatMap((r) => labelsOf.get(r.workItemId!) ?? []));
  const withoutR = rows.filter((r) => r.runbooksOffered.length === 0 && r.workItemId
    && (labelsOf.get(r.workItemId) ?? []).some((l) => labels.has(l)));
  if (withR.length < COMPARE_MIN || withoutR.length < COMPARE_MIN) {
    return {
      available: false,
      reason: `Not enough runs to compare: ${withR.length} with this runbook and ${withoutR.length} without it on work sharing a label; each side needs ${COMPARE_MIN}.`,
      withRunbookRuns: withR.length, withoutRunbookRuns: withoutR.length,
    };
  }
  return { available: true, withRunbook: sideFigures(withR), withoutRunbook: sideFigures(withoutR), sharedLabels: [...labels].sort() };
}

/** The evidence for one runbook over `rows` (every report; the window is applied here). */
export function runbookEvidence(
  id: string, rows: readonly RunReport[], opts: { nowMs: number; labelsOf?: ReadonlyMap<string, string[]>; windowDays?: number },
): RunbookEvidence {
  const windowDays = opts.windowDays ?? EVIDENCE_WINDOW_DAYS;
  const since = windowStart(opts.nowMs, windowDays);
  const recent = inWindow(rows, since);
  const mine = recent.filter((r) => given(r, id))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.runRef.localeCompare(b.runRef));
  const followed: Record<Followed, number> = { yes: 0, partly: 0, no: 0, unsaid: 0 };
  const outcomes = emptyOutcomes();
  let followedDone = 0;
  const runs: EvidenceRun[] = mine.map((r) => {
    const f = followedOf(r, id);
    followed[f] += 1;
    outcomes[r.outcome] += 1;
    if ((f === 'yes' || f === 'partly') && r.outcome === 'done') followedDone += 1;
    return {
      runRef: r.runRef, workItemId: r.workItemId, endedAt: r.endedAt, outcome: r.outcome,
      version: r.runbooksOffered.find((o) => o.id === id)?.version ?? null, followed: f, loaded: loaded(r, id),
    };
  });
  return {
    runbookId: id, windowDays, since, given: mine.length, followed,
    loaded: runs.filter((r) => r.loaded).length, outcomes, followedDone, runs,
    comparison: compareRuns(id, recent, opts.labelsOf ?? new Map()),
  };
}

export interface ProposalRow { source: { kind: 'run' | 'person' | 'system' }; status: 'open' | 'accepted' | 'rejected' | 'merged' | 'withdrawn'; created_at: string }

/** The loop as a whole, over `rows` and the run-authored proposals. */
export function loopEvidence(
  rows: readonly RunReport[], proposals: readonly ProposalRow[], opts: { nowMs: number; windowDays?: number },
): LoopEvidence {
  const windowDays = opts.windowDays ?? EVIDENCE_WINDOW_DAYS;
  const since = windowStart(opts.nowMs, windowDays);
  const recent = inWindow(rows, since);
  const givenRuns = recent.filter((r) => r.runbooksOffered.length > 0);
  const saidFollowed = givenRuns.filter((r) => r.runbooksOffered.some((o) => ['yes', 'partly'].includes(followedOf(r, o.id))));
  const per = new Map<string, { given: number; saidFollowed: number; followedDone: number }>();
  for (const r of givenRuns) {
    for (const o of r.runbooksOffered) {
      const row = per.get(o.id) ?? { given: 0, saidFollowed: 0, followedDone: 0 };
      row.given += 1;
      const f = followedOf(r, o.id);
      if (f === 'yes' || f === 'partly') {
        row.saidFollowed += 1;
        if (r.outcome === 'done') row.followedDone += 1;
      }
      per.set(o.id, row);
    }
  }
  const fromRuns = proposals.filter((p) => p.source.kind === 'run' && p.created_at >= since);
  const count = (s: ProposalRow['status']) => fromRuns.filter((p) => p.status === s).length;
  return {
    windowDays, since, runs: recent.length, runsGiven: givenRuns.length,
    runsSaidFollowed: saidFollowed.length, runsSaidFollowedDone: saidFollowed.filter((r) => r.outcome === 'done').length,
    proposalsFromRuns: {
      total: fromRuns.length, open: count('open'), accepted: count('accepted'), rejected: count('rejected'),
      merged: count('merged'), withdrawn: count('withdrawn'),
    },
    runbooks: [...per].map(([runbookId, v]) => ({ runbookId, ...v }))
      .sort((a, b) => b.given - a.given || a.runbookId.localeCompare(b.runbookId)),
  };
}

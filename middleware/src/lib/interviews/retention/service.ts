// Retention, as a feature (docs/interviews-tenant-plan.md decision 17, row I6.3): a candidate's deletion request and the
// hourly sweep. What each removes is rules.ts's classes; who removes each kind is the registry (registry.ts); every run
// leaves one row in the deletion log (store.ts) that says what went and what is left.
//
//   deleteCandidateMedia(candidateId, by)
//       Every interview of the candidate, open ones included: the media erasers now; the candidate's live invites
//       revoked; the résumé file and row removed; the contact details taken out of the candidate row (rules.ts
//       REDACTED_CONTACT). The scorecards and consents stay for their period. One log row, written BEFORE the work
//       (every step `pending`), so a run that stops part way is still in the log and the sweep finishes it.
//       Idempotent: an open request is finished rather than doubled; a finished request that covers every interview
//       the candidate has is returned as it is (`created: false`) and nothing runs again.
//   sweep()
//       First the open rows (a step that failed or met a running call), overdue ones first (overdue.ts: not done by their
//       `dueBy`); each that is still open past its date afterwards rings the opening's recruiter once (`ringOverdue`).
//       Then media past its period, then records past
//       theirs (with the résumé and contact details once ALL of the candidate's interviews are past it), oldest first,
//       at most MAX_ROWS_PER_RUN rows; one row per interview touched. Never throws; nothing while the flag is off.
//
// A failure is logged by kind only: the error's message may carry data and is not kept or printed.

import { randomUUID } from 'node:crypto';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { interviewsEnabled } from '../flag.js';
import { inviteStore } from '../invite/store.js';
import { removeResumeFor } from '../resume/service.js';
import { loadWorld } from '../store.js';
import { interviewsStore } from '../store-select.js';
import { INTERVIEWS_TENANT, type Interview, type InterviewsWorld } from '../types.js';
import { registerOwnErasers } from './erasers.js';
import { retentionPeriods, type RetentionPeriods } from './periods.js';
import { recordStatements, type RecordStatements } from './records.js';
import { EraserBusy, EraserSkipped, erasersOf } from './registry.js';
import { candidateRecordsDue, deletionDueByMs, dueAtMs, isDue, periodStartMs } from './rules.js';
import { deletionStore, type DeletionReason, type DeletionRow, type DeletionStore, type LeftItem, type RemovedCount } from './store.js';
import { overdueFirst, ringOverdue } from './overdue.js';

registerOwnErasers();

/** Rows one sweep creates or retries; the next hourly sweep takes the rest. */
export const MAX_ROWS_PER_RUN = 50;
export const RETENTION_TICK_MS = 3_600_000;

export interface RetentionDeps {
  now: () => number;
  store: () => DeletionStore;
  load: () => Promise<InterviewsWorld>;
  records: () => RecordStatements;
  removeResume: (candidateId: string) => Promise<boolean>;
  /** Revoke the interview's live invite; true when there was one. */
  revokeInvite: (interviewId: string, at: string, by: string) => Promise<boolean>;
  periods: () => RetentionPeriods;
  enabled: () => boolean;
  newId: () => string;
  /** Ring the recruiters of the rows that are late (overdue.ts); returns how many bells went. */
  ringOverdue: (rows: readonly DeletionRow[], world: InterviewsWorld, nowMs: number) => Promise<number>;
}

const defaults: RetentionDeps = {
  now: Date.now,
  store: deletionStore,
  load: () => loadWorld(interviewsStore()),
  records: recordStatements,
  removeResume: removeResumeFor,
  revokeInvite: async (interviewId, at, by) => {
    const latest = await inviteStore().latestInvite(interviewId);
    if (!latest || latest.revokedAt !== null) return false;
    await inviteStore().revokeInvite(interviewId, at, by);
    return true;
  },
  periods: () => retentionPeriods(),
  enabled: interviewsEnabled,
  newId: () => `del-${randomUUID()}`,
  ringOverdue: (rows, world, nowMs) => ringOverdue(rows, world, nowMs),
};

const iso = (ms: number): string => new Date(ms).toISOString();

export function interviewsOfCandidate(world: InterviewsWorld, candidateId: string): Interview[] {
  const apps = new Set(world.applications.filter((a) => a.candidateId === candidateId).map((a) => a.id));
  return world.interviews.filter((i) => apps.has(i.applicationId));
}

function candidateOf(world: InterviewsWorld, iv: Interview): string | null {
  return world.applications.find((a) => a.id === iv.applicationId)?.candidateId ?? null;
}

interface Step { kind: string; run: () => Promise<number> }

/** Every step a row of this reason runs. `withCandidate`: a record row also takes the résumé and contact details. */
function stepsFor(row: Pick<DeletionRow, 'reason' | 'candidateId' | 'interviewIds'>, d: RetentionDeps, by: string | null, withCandidate: boolean): Step[] {
  const ids = row.interviewIds;
  const registered = (cls: 'media' | 'record'): Step[] => erasersOf(cls).map((e) => ({ kind: e.kind, run: () => e.erase(ids) }));
  const resume: Step = { kind: 'resume', run: async () => ((await d.removeResume(row.candidateId)) ? 1 : 0) };
  const contact: Step = { kind: 'contact-details', run: () => d.records().redactCandidate(row.candidateId) };
  const reasons: Step = { kind: 'stage-reasons', run: () => d.records().redactStageReasons(row.candidateId) };
  if (row.reason === 'media-period') return registered('media');
  if (row.reason === 'record-period') return [...registered('record'), ...(withCandidate ? [resume, contact, reasons] : [])];
  const invite: Step = {
    kind: 'invite',
    run: async () => {
      let n = 0;
      for (const id of ids) if (await d.revokeInvite(id, iso(d.now()), by ?? 'retention')) n += 1;
      return n;
    },
  };
  return [...registered('media'), invite, resume, contact, reasons];
}

/** A row's steps that are still to do: everything the first time, then only what is left to retry. */
function stepsLeft(row: DeletionRow, all: Step[]): Step[] {
  const retry = new Set(row.left.filter((l) => l.retry).map((l) => l.kind));
  // A kind whose eraser is registered after the row was written (or a step of a newer build) is not invented here.
  return all.filter((s) => retry.has(s.kind));
}

async function runSteps(row: DeletionRow, steps: Step[], d: RetentionDeps): Promise<DeletionRow> {
  const counts = new Map<string, number>(row.removed.map((r) => [r.kind, r.count]));
  const add = (kind: string, n: number) => { if (n > 0) counts.set(kind, (counts.get(kind) ?? 0) + n); };
  const ran = new Set(steps.map((s) => s.kind));
  const left: LeftItem[] = row.left.filter((l) => !ran.has(l.kind));
  for (const step of steps) {
    try {
      add(step.kind, await step.run());
    } catch (err) {
      if (err instanceof EraserSkipped) { left.push({ kind: step.kind, why: err.why, retry: false }); continue; }
      if (err instanceof EraserBusy) { add(step.kind, err.removed); left.push({ kind: step.kind, why: err.why, retry: true }); continue; }
      left.push({ kind: step.kind, why: 'failed', retry: true });
      console.warn(`[interviews] retention could not remove ${step.kind} (${row.reason}); the next sweep tries again`);
    }
  }
  const removed: RemovedCount[] = [...counts].map(([kind, count]) => ({ kind, count }));
  const doneAt = left.some((l) => l.retry) ? null : iso(d.now());
  const saved = await d.store().update(row.id, { doneAt, removed, left, attempts: row.attempts + 1 }, row.revision);
  if (saved.ok) return saved.row;
  // Another run saved first: what it saved is the truth.
  return saved.reason === 'stale' ? saved.row : row;
}

async function startRow(d: RetentionDeps, fields: { candidateId: string; interviewIds: string[]; reason: DeletionReason; by: string | null }, steps: Step[]): Promise<DeletionRow> {
  const now = d.now();
  const row = await d.store().insert({
    id: d.newId(), candidateId: fields.candidateId, interviewIds: fields.interviewIds, reason: fields.reason,
    requestedAt: iso(now), requestedBy: fields.by, dueBy: iso(deletionDueByMs(now, d.periods())), doneAt: null,
    removed: [], left: steps.map((s) => ({ kind: s.kind, why: 'pending', retry: true })), attempts: 0,
  });
  return runSteps(row, steps, d);
}

export interface DeletionOutcome { row: DeletionRow; created: boolean }

/** The candidate's deletion request (the route has checked who asks and that the candidate is in their scope). */
export async function deleteCandidateMedia(candidateId: string, by: string, deps: Partial<RetentionDeps> = {}): Promise<DeletionOutcome> {
  const d = { ...defaults, ...deps };
  const world = await d.load();
  const ids = interviewsOfCandidate(world, candidateId).map((i) => i.id);
  const rows = (await d.store().forCandidate(candidateId)).filter((r) => r.reason === 'request');
  const open = rows.find((r) => r.doneAt === null);
  if (open) return { row: await runSteps(open, stepsLeft(open, stepsFor(open, d, by, true)), d), created: false };
  const last = rows[0];
  if (last && ids.every((id) => last.interviewIds.includes(id))) return { row: last, created: false };
  const fields = { candidateId, interviewIds: ids, reason: 'request' as const, by };
  return { row: await startRow(d, fields, stepsFor(fields, d, by, true)), created: true };
}

/** The candidate's deletion log, newest first. */
export async function deletionsOf(candidateId: string, deps: Partial<RetentionDeps> = {}): Promise<DeletionRow[]> {
  return ({ ...defaults, ...deps }).store().forCandidate(candidateId);
}

export interface SweepResult { retried: number; media: number; records: number }

/** One pass of the sweep. Never throws. */
export async function sweep(deps: Partial<RetentionDeps> = {}): Promise<SweepResult> {
  const d = { ...defaults, ...deps };
  const out: SweepResult = { retried: 0, media: 0, records: 0 };
  if (!d.enabled()) return out;
  return runWithDbTenant(INTERVIEWS_TENANT, async () => {
    try {
      let budget = MAX_ROWS_PER_RUN;
      const world = await d.load();
      const stillOpen: DeletionRow[] = [];
      for (const row of overdueFirst(await d.store().open(budget), d.now())) {
        // A retry runs only what its row says is left, so the candidate's steps are offered and filtered by the row.
        let after = row;
        try { after = await runSteps(row, stepsLeft(row, stepsFor(row, d, row.requestedBy, true)), d); } catch { /* the next sweep */ }
        if (after.doneAt === null) stillOpen.push(after);
        out.retried += 1; budget -= 1;
      }
      // A row still open past its date: its opening's recruiter is told once (overdue.ts says how "once" is kept).
      try { await d.ringOverdue(stillOpen, world, d.now()); } catch { /* the next sweep */ }
      const nowMs = d.now();
      const p = d.periods();
      const [mediaDone, requested, recordsDone] = await Promise.all([
        d.store().coverage(['media-period']), d.store().coverage(['request']), d.store().coverage(['record-period']),
      ]);
      const oldestFirst = (cls: 'media' | 'record') => (a: Interview, b: Interview) => (dueAtMs(a, cls, p) ?? 0) - (dueAtMs(b, cls, p) ?? 0);
      // A request covers an interview's media only if the interview was already closed when it was asked.
      const mediaDue = world.interviews.filter((iv) => {
        if (!isDue(iv, 'media', p, nowMs) || mediaDone.has(iv.id)) return false;
        const askedAt = requested.get(iv.id);
        return !(askedAt && Date.parse(askedAt) >= (periodStartMs(iv) ?? Infinity));
      }).sort(oldestFirst('media'));
      for (const iv of mediaDue) {
        if (budget <= 0) break;
        const candidateId = candidateOf(world, iv);
        if (!candidateId) continue;
        const fields = { candidateId, interviewIds: [iv.id], reason: 'media-period' as const, by: null };
        try { await startRow(d, fields, stepsFor(fields, d, null, false)); out.media += 1; } catch { /* the next sweep */ }
        budget -= 1;
      }
      const recordDue = world.interviews.filter((iv) => isDue(iv, 'record', p, nowMs) && !recordsDone.has(iv.id)).sort(oldestFirst('record'));
      for (const iv of recordDue) {
        if (budget <= 0) break;
        const candidateId = candidateOf(world, iv);
        if (!candidateId) continue;
        const all = interviewsOfCandidate(world, candidateId);
        const fields = { candidateId, interviewIds: [iv.id], reason: 'record-period' as const, by: null };
        try { await startRow(d, fields, stepsFor(fields, d, null, candidateRecordsDue(all, p, nowMs))); out.records += 1; } catch { /* the next sweep */ }
        budget -= 1;
      }
    } catch (err) {
      console.warn(`[interviews] retention sweep failed (will keep trying): ${(err as Error).name}`);
    }
    return out;
  });
}

/** Start the hourly sweep; returns its stopper. Unref'd; a tick still running skips the next. */
export function startInterviewsRetentionSweep(everyMs = RETENTION_TICK_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sweep().finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

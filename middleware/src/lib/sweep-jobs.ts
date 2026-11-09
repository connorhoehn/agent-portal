// "Run sweeps now" in the background (docs/voice-navigator-gaps.md G19).
//
// POST /api/work/sweeps/run answers when the sweeps are done, with their
// counts and no id: right for the Findings page's button, which waits on it,
// and wrong for a request that should be queued and reported back later (the
// voice's queue_work). `background: true` on the same route starts the same
// work here instead and answers at once with a job id; GET
// /api/work/sweeps/jobs/:id reads it back. The sweeps themselves are
// org-sweeps.ts's runSweep / runAllSweeps, unchanged: each still writes its
// own sweep_runs row, so bot_sweep_status and the run history see a
// background run exactly as they see a button run.
//
// A job is a record of one request, kept in this process's memory: it belongs
// to the user who started it (any other caller reads 404), lives at most
// JOB_TTL_MS after it ends, and the table never holds more than MAX_JOBS. A
// user has at most one job queued or running (`activeSweepJob`; the route
// answers 409 with it), and the route also holds them to a few an hour. A
// restart forgets the record, never the sweep's own rows. Each state change is
// emitted on the dispatcher's `job` feed (GET /api/work/events), the stream the
// Work pages already hold, as `sweep:queued|running|done|failed`, so a client
// subscribed there re-reads the job instead of polling blind.
//
// Under MOCK_AURORA a sweep is a few in-memory writes and ends at once, so a
// background job would jump straight to done; the mock paces each state by
// SWEEP_JOB_MOCK_STEP_MS (default 1500 ms, 0 = no pacing) so a dev:mock run
// shows the job queued, then running, then done.

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { runAllSweeps, runSweep, SWEEP_NAMES, type SweepName } from '../providers/org-sweeps.js';
import { dispatcherEvents } from './job-dispatcher.js';

export type SweepJobState = 'queued' | 'running' | 'done' | 'failed';

export interface SweepJob {
  jobId: string;
  kind: 'sweep';
  /** The sweep it runs, or null for all of them (the nightly run). */
  sweep: SweepName | null;
  title: string;
  state: SweepJobState;
  /** The outcome in words once it ends: counts, or the error's first line. */
  detail: string | null;
  href: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Owned extends SweepJob { owner: string; tenant: string; endedAtMs: number | null }

/** Where a sweep's outcome is read: the findings board. */
export const SWEEP_JOB_HREF = '/iq/work/findings';
export const MAX_JOBS = 200;
export const JOB_TTL_MS = 60 * 60_000;
const MAX_DETAIL = 200;

const jobs = new Map<string, Owned>();

const SWEEP_LABEL: Record<SweepName, string> = {
  bus_factor: 'bus factor', stale_docs: 'stale docs', orphan_decisions: 'orphan decisions',
};

export function sweepJobTitle(sweep: SweepName | null): string {
  return sweep ? `The ${SWEEP_LABEL[sweep]} sweep` : 'The nightly org sweeps';
}

function mockStepMs(): number {
  const raw = (process.env['SWEEP_JOB_MOCK_STEP_MS'] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? n : 1500;
}

const pause = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

function prune(now: number): void {
  for (const [id, j] of jobs) if (j.endedAtMs != null && now - j.endedAtMs > JOB_TTL_MS) jobs.delete(id);
  // Oldest first (Map keeps insertion order): an unended job is dropped only past the cap.
  while (jobs.size >= MAX_JOBS) {
    const oldest = jobs.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    jobs.delete(oldest);
  }
}

function publicJob(j: Owned): SweepJob {
  const { owner: _o, tenant: _t, endedAtMs: _e, ...rest } = j;
  return { ...rest };
}

function move(j: Owned, state: SweepJobState, detail: string | null = j.detail): void {
  j.state = state;
  j.detail = detail ? detail.split('\n')[0]!.slice(0, MAX_DETAIL) : null;
  const now = clock.nowIso();
  if (state === 'running') j.startedAt = now;
  if (state === 'done' || state === 'failed') { j.finishedAt = now; j.endedAtMs = clock.now().getTime(); }
  dispatcherEvents.emit('job', { kind: `sweep:${state}`, jobId: j.jobId, ts: now });
}

type Counts = { found: number; created: number; resolved: number };
function outcome(results: Counts[], released: number): string {
  const sum = (k: keyof Counts) => results.reduce((n, r) => n + (r[k] ?? 0), 0);
  const parts = [
    `${sum('found')} finding${sum('found') === 1 ? '' : 's'}`,
    sum('created') ? `${sum('created')} new` : '',
    sum('resolved') ? `${sum('resolved')} resolved` : '',
    released ? `${released} put back` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

async function play(j: Owned): Promise<void> {
  const step = config.mock.aurora ? mockStepMs() : 0;
  try {
    await pause(step);
    move(j, 'running');
    await pause(step);
    if (j.sweep) {
      const r = await runSweep(j.sweep);
      move(j, 'done', outcome([r], 0));
    } else {
      const report = await runAllSweeps();
      // runAllSweeps logs and skips a sweep that throws: fewer results than sweeps is a partial failure.
      const ran = report.results.length;
      if (ran === 0) throw new Error('no sweep completed');
      const partial = ran < SWEEP_NAMES.length ? `${ran} of ${SWEEP_NAMES.length} sweeps ran; ` : '';
      move(j, ran < SWEEP_NAMES.length ? 'failed' : 'done', `${partial}${outcome(report.results, report.released)}`);
    }
  } catch (err) {
    move(j, 'failed', (err as Error)?.message || 'the sweep failed');
  }
}

/** Queue one sweep (or all of them) for `owner` and start it; answers before the sweep runs. */
export function startSweepJob(input: { owner: string; tenant: string; sweep: SweepName | null }): SweepJob {
  prune(clock.now().getTime());
  const j: Owned = {
    jobId: `sweepjob-${randomUUID()}`, kind: 'sweep', sweep: input.sweep, title: sweepJobTitle(input.sweep),
    state: 'queued', detail: null, href: SWEEP_JOB_HREF, queuedAt: clock.nowIso(), startedAt: null, finishedAt: null,
    owner: input.owner, tenant: input.tenant, endedAtMs: null,
  };
  jobs.set(j.jobId, j);
  dispatcherEvents.emit('job', { kind: 'sweep:queued', jobId: j.jobId, ts: j.queuedAt });
  void play(j);
  return publicJob(j);
}

/**
 * The owner's job still queued or running, else null: one background sweep per
 * person at a time, in any tenant. A job queued more than JOB_TTL_MS ago no
 * longer counts, so a sweep that never ends cannot lock its owner out until a
 * restart.
 */
export function activeSweepJob(owner: string): SweepJob | null {
  const now = clock.now().getTime();
  for (const j of jobs.values()) {
    if (j.owner !== owner || j.endedAtMs != null) continue;
    if (now - Date.parse(j.queuedAt) > JOB_TTL_MS) continue;
    return publicJob(j);
  }
  return null;
}

/** The caller's own job in its own tenant, else null (the route answers 404 either way). */
export function getSweepJob(jobId: string, caller: { sub: string; tenant: string }): SweepJob | null {
  const j = jobs.get(jobId);
  if (!j || j.owner !== caller.sub || j.tenant !== caller.tenant) return null;
  return publicJob(j);
}

/** The caller's own jobs in its own tenant, newest queued first (what getSweepJob would let it read). */
export function listSweepJobs(caller: { sub: string; tenant: string }, limit = 20): SweepJob[] {
  const own = [...jobs.values()].filter((j) => j.owner === caller.sub && j.tenant === caller.tenant);
  return own.sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt)).slice(0, limit).map(publicJob);
}

/** Tests only. */
export function resetSweepJobs(): void {
  jobs.clear();
}

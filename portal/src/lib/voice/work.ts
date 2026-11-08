// queue_work (docs/voice-navigator-gaps.md G19): background work the voice
// queues, one toast that follows it, the notification center's entry and the
// spoken outcome.
//
// The planner runs before the card, reads only: the kind must be one of the
// session tenant's (QUEUE_WORK_KINDS) and can() must hold the page button's
// action (QUEUE_WORK_ACTIONS), both checked before any request; then the
// target is resolved by the read the page itself lists from (the sweep names,
// GET /api/bots, GET /api/pipelines/runbooks), so the card names exactly the
// sweep, bot or runbook that will run. A cancel leaves nothing behind.
//
// The runner, once confirmed, calls the route the page's button calls, with
// the button's body and none of the over-budget confirm flags: a run the money
// brakes stop is answered as a refusal that names the page, never pushed
// through by voice. The voice's `note` is a label on the card and the toast;
// it is never sent (a bot run's `instruction` steers an agent, and model text
// never reaches a prompt, as with run_command's phrases).
//
//   sweep    POST /api/work/sweeps/run { sweep?, background: true } -> 202 { jobId }
//   bot-run  POST /api/bots/:id/run {}                              -> 202 { run: { id } }
//   pipeline POST /api/pipelines/definitions/:id/dry-run {}         -> 202 { run: { id } }
//
// The id the toast is keyed on is the one in that response; the model never
// supplies one (the schema has no such argument and refuses any it sends).
//
// VoiceJobTracker follows each job to the end: a read of its state when the
// stream the page already holds says something moved (GET /api/work/events in
// orgiq, which the sweep jobs and the dispatcher's jobs both emit on; GET
// /api/pipelines/runs/:id/events in pipelines), and a slower poll in case the
// stream is down. Every change calls the library's toastJob with the same id,
// so one toast moves queued -> running -> done (with the page link) or failed
// (with the error); the library removes it `toastSeconds` after it settles and
// calls onSettled once, which mirrors the outcome into the notification center
// and, while a session is live, has the voice say it.
//
// No React and only `.ts` imports, so `node --test` runs it.

import type { Notification } from '@connorhoehn/realtime-modules/client';
import { QUEUE_WORK_ACTIONS, QUEUE_WORK_KINDS, type QueueWorkKind } from './catalogue.ts';
import {
  ambiguous, done, failed, readFailure, readJson, refused,
  type JobTracking, type QueuedJob, type ToolContext, type ToolResult, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';

// ── targets ─────────────────────────────────────────────────────────────────

export type SweepName = 'bus_factor' | 'stale_docs' | 'orphan_decisions';
const SWEEP_LABEL: Record<SweepName, string> = { bus_factor: 'bus factor', stale_docs: 'stale docs', orphan_decisions: 'orphan decisions' };
const SWEEP_WORDS: Array<[RegExp, SweepName]> = [
  [/\b(bus|factor)\b/, 'bus_factor'],
  [/\b(stale|docs?|documents?)\b/, 'stale_docs'],
  [/\b(orphan(ed)?|decisions?)\b/, 'orphan_decisions'],
];
const ALL_SWEEPS = /\b(all|every|everything|nightly|org|sweeps?|full)\b/;

/** One sweep, null for all of them (the nightly run), or undefined when the words name none. */
export function resolveSweep(target: string): SweepName | null | undefined {
  const t = target.toLowerCase().replace(/[_-]+/g, ' ');
  const named = [...new Set(SWEEP_WORDS.filter(([re]) => re.test(t)).map(([, n]) => n))];
  if (named.length === 1) return named[0];
  if (named.length > 1) return undefined;
  return ALL_SWEEPS.test(t) ? null : undefined;
}

export function sweepTitle(sweep: SweepName | null): string {
  return sweep ? `The ${SWEEP_LABEL[sweep]} sweep` : 'The nightly org sweeps';
}

const STOP = new Set(['the', 'a', 'an', 'bot', 'bots', 'run', 'runs', 'pipeline', 'pipelines', 'runbook', 'dry', 'for', 'of', 'now', 'please', 'my']);
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Rows whose name holds every meaningful word the user said (an exact name wins). */
export function matchByName<T>(rows: readonly T[], name: (r: T) => string, said: string): T[] {
  const want = tokens(said).filter((w) => !STOP.has(w));
  const exact = rows.filter((r) => tokens(name(r)).join(' ') === tokens(said).join(' '));
  if (exact.length) return exact;
  if (!want.length) return [];
  return rows.filter((r) => {
    const have = tokens(name(r));
    return want.every((w) => have.some((h) => h === w || (w.length >= 3 && h.startsWith(w))));
  });
}

// ── planner and runner ──────────────────────────────────────────────────────

interface WorkPlan { kind: QueueWorkKind; title: string; sweep?: SweepName | null; botId?: string; definitionId?: string; note?: string }
interface BotRow { id: string; name: string; enabled?: boolean; pausedReason?: string | null }
interface RunbookRow { id: string; title: string; enabled?: boolean }

const KIND_WORDS: Record<QueueWorkKind, string> = { sweep: 'Sweeps', 'bot-run': 'Bot runs', pipeline: 'Pipeline dry-runs' };
const KIND_HOME: Record<QueueWorkKind, string> = { sweep: 'the Work workspace', 'bot-run': 'the Work workspace', pipeline: 'the Pipelines workspace' };
const ROLE_REFUSAL: Record<QueueWorkKind, string> = {
  sweep: "I can't run the org sweeps with your role.",
  'bot-run': "I can't run bots with your role.",
  pipeline: "I can't start pipeline runs with your role.",
};
const SPEND: Record<QueueWorkKind, string> = {
  sweep: 'It reads the org graph and refreshes the findings board in the background; it spends nothing.',
  'bot-run': "It starts the bot's run on a computer in the background and spends against the bot's budget.",
  pipeline: 'It queues a governed dry-run on the pipeline queue and spends against its estimate.',
};

const withNote = (detail: string, note: string | undefined) => (note ? `${detail} Note: ${note}` : detail);
const listOf = (names: string[]) => names.slice(0, 5).join(', ');

const planQueueWork: VoiceToolPlanner = async (args, ctx) => {
  const kind = String(args['kind']) as QueueWorkKind;
  // Both checked before any request (the gate is the page button's, so a refusal here matches the page).
  if (!(QUEUE_WORK_KINDS[ctx.tenant] ?? []).includes(kind)) return { result: refused(`${KIND_WORDS[kind] ?? 'That work'} are queued in ${KIND_HOME[kind] ?? 'another workspace'}.`) };
  if (!ctx.can(QUEUE_WORK_ACTIONS[kind])) return { result: refused(ROLE_REFUSAL[kind]) };
  if (!ctx.jobs) return { result: refused('This dock cannot follow background work right now, so nothing was queued.') };
  const target = String(args['target'] ?? '').trim();
  const note = typeof args['note'] === 'string' && args['note'].trim() ? args['note'].trim() : undefined;

  if (kind === 'sweep') {
    const sweep = resolveSweep(target);
    if (sweep === undefined) {
      return { result: refused(`There is no "${target}" sweep. The sweeps are bus factor, stale docs and orphan decisions, or all of them.`, { sweeps: ['all', ...Object.values(SWEEP_LABEL)] }) };
    }
    const title = sweepTitle(sweep);
    return { plan: { title: `Run ${title.charAt(0).toLowerCase()}${title.slice(1)} now`, detail: withNote(SPEND.sweep, note), data: { kind, title, sweep, ...(note ? { note } : {}) } satisfies WorkPlan } };
  }

  if (kind === 'bot-run') {
    const read = await readJson<{ bots?: BotRow[] }>(ctx, '/api/bots');
    if (!read.ok) return { result: readFailure('the bots', read.status) };
    const bots = read.body.bots ?? [];
    const found = matchByName(bots, (b) => b.name, target);
    if (found.length === 0) return { result: refused(`No bot is called "${target}".`, { bots: bots.slice(0, 10).map((b) => b.name) }) };
    if (found.length > 1) return { result: ambiguous(`Several bots match "${target}": ${listOf(found.map((b) => b.name))}. Which one?`, found.map((b) => ({ name: b.name }))) };
    const bot = found[0]!;
    if (bot.enabled === false) return { result: refused(`${bot.name} is paused${bot.pausedReason ? `: ${bot.pausedReason}` : ''}. Resume it on its page first.`) };
    const title = `The ${bot.name} bot`;
    return { plan: { title: `Run the ${bot.name} bot now`, detail: withNote(SPEND['bot-run'], note), data: { kind, title, botId: bot.id, ...(note ? { note } : {}) } satisfies WorkPlan } };
  }

  const read = await readJson<{ runbooks?: RunbookRow[] }>(ctx, '/api/pipelines/runbooks');
  if (!read.ok) return { result: readFailure('the runbooks', read.status) };
  const runbooks = read.body.runbooks ?? [];
  const found = matchByName(runbooks, (r) => r.title, target);
  if (found.length === 0) return { result: refused(`No runbook matches "${target}".`, { runbooks: runbooks.slice(0, 10).map((r) => r.title) }) };
  if (found.length > 1) return { result: ambiguous(`Several runbooks match "${target}": ${listOf(found.map((r) => r.title))}. Which one?`, found.map((r) => ({ title: r.title }))) };
  const rb = found[0]!;
  if (rb.enabled === false) return { result: refused(`"${rb.title}" was dismissed from the ladder; reopen it on its page first.`) };
  return { plan: { title: `Dry-run "${rb.title}"`, detail: withNote(SPEND.pipeline, note), data: { kind, title: `The "${rb.title}" dry-run`, definitionId: rb.id, ...(note ? { note } : {}) } satisfies WorkPlan } };
};

type Posted = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> | null };

async function post(ctx: ToolContext, url: string, body: Record<string, unknown>): Promise<Posted> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, body: null };
  }
  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  return res.ok ? { ok: true, status: res.status, body: json ?? {} } : { ok: false, status: res.status, body: json };
}

/** A route's refusal in words: a money brake names its page, never a confirm the voice cannot give. */
function postRefusal(plan: WorkPlan, posted: Extract<Posted, { ok: false }>, page: string): ToolResult {
  const error = typeof posted.body?.['error'] === 'string' ? posted.body['error'] as string : null;
  if (posted.status === 0) return failed('Could not reach the server; nothing was queued.');
  if (posted.status === 401 || posted.status === 403) return refused(error && posted.status === 403 && !/^forbidden$/i.test(error) ? `Not queued: ${error}.` : ROLE_REFUSAL[plan.kind]);
  if (posted.body?.['confirmFlag'] || posted.status === 402 || posted.status === 409 || posted.status === 429) {
    return refused(`Not queued; it needs a confirm on its page, not by voice: ${error ?? `the server answered ${posted.status}`}`, { page });
  }
  return failed(`${plan.title} could not be queued (HTTP ${posted.status})${error ? `: ${error}` : ''}.`);
}

const runQueueWork: VoiceToolRunner = async (_args, ctx, planned) => {
  const plan = planned as WorkPlan | undefined;
  if (!plan) return failed('Nothing was planned to queue.');
  const jobs = ctx.jobs;
  if (!jobs) return refused('This dock cannot follow background work right now, so nothing was queued.');
  let job: QueuedJob | null = null;
  if (plan.kind === 'sweep') {
    const posted = await post(ctx, '/api/work/sweeps/run', { ...(plan.sweep ? { sweep: plan.sweep } : {}), background: true });
    if (!posted.ok) return postRefusal(plan, posted, '/iq/work/findings');
    const id = posted.body['jobId'];
    if (typeof id === 'string' && id) job = { jobId: id, kind: 'sweep', title: plan.title, href: typeof posted.body['href'] === 'string' ? posted.body['href'] as string : '/iq/work/findings' };
  } else if (plan.kind === 'bot-run') {
    const page = `/admin/bots/${encodeURIComponent(plan.botId!)}`;
    const posted = await post(ctx, `/api/bots/${encodeURIComponent(plan.botId!)}/run`, {});
    if (!posted.ok) return postRefusal(plan, posted, page);
    const id = (posted.body['run'] as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && id) job = { jobId: id, kind: 'bot-run', title: plan.title, href: page, botId: plan.botId! };
  } else {
    const posted = await post(ctx, `/api/pipelines/definitions/${encodeURIComponent(plan.definitionId!)}/dry-run`, {});
    if (!posted.ok) return postRefusal(plan, posted, '/pipelines/runbooks');
    const id = (posted.body['run'] as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && id) job = { jobId: id, kind: 'pipeline', title: plan.title, href: `/pipelines/runs/${encodeURIComponent(id)}` };
  }
  if (!job) return failed(`${plan.title} was accepted but the server named no job to follow; check its page.`);
  if (plan.note) job.note = plan.note;
  jobs.track(job);
  return done('work_queued', {
    jobId: job.jobId, workKind: job.kind, title: job.title, state: 'queued', href: job.href,
    next: 'Say it is queued and that you will say when it is done. The portal shows its progress.',
  }, `${job.title}: queued`);
};

export const WORK_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = { queue_work: runQueueWork };
export const WORK_PLANNERS: Readonly<Record<string, VoiceToolPlanner>> = { queue_work: planQueueWork };

// ── the follower ────────────────────────────────────────────────────────────

export type JobState = 'queued' | 'running' | 'done' | 'failed';

/** The library's useToast() keyed job toast (ui-components 2.510.3 `toastJob` / `dismissJobToast`). */
export interface JobToastSink {
  toastJob(opts: {
    id: string; title: string; state: JobState; detail?: string; href?: string; hrefLabel?: string;
    dismissAfterMs?: number;
    onSettled?(job: { id: string; title: string; state: 'done' | 'failed'; detail?: string; href?: string }): void;
  }): void;
  dismissJobToast(id: string): void;
}

/** What the notification center keeps for a job that ended (lib/localNotifications.ts). */
export interface JobNotice { jobId: string; kind: QueuedJob['kind']; title: string; state: 'done' | 'failed'; detail?: string; href: string }

/** The notification center's entry for an ended job: the bell's `job` kind, in the tenant it was queued in. */
export function jobNotification(n: JobNotice, tenant: string, at: Date): Notification {
  return {
    id: `voice-job:${n.jobId}`, type: 'system', title: `${n.title} ${n.state === 'done' ? 'finished' : 'failed'}`,
    ...(n.detail ? { body: n.detail } : {}), timestamp: at.toISOString(),
    payload: { tenant, kind: 'job', jobId: n.jobId, workKind: n.kind, state: n.state },
    action: { label: 'Open', href: n.href },
  };
}

type Timer = unknown;

export interface JobTrackerOptions {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  toast: JobToastSink;
  /** Mirror an ended job into the notification center (called from the toast's onSettled, once). */
  notify(notice: JobNotice): void;
  /** Say the outcome; the controller speaks only while a session is live. */
  speak(line: string): void;
  /** VOICE_TOAST_SECONDS from the mint (default DEFAULT_TOAST_SECONDS). */
  toastSeconds(): number;
  /** The stream that says a job may have moved; returns the unsubscribe. */
  wake?(job: QueuedJob, onEvent: () => void): () => void;
  pollMs?: number;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(t: Timer): void;
}

export const DEFAULT_TOAST_SECONDS = 8;
/** The fallback read when the stream says nothing. */
export const JOB_POLL_MS = 4000;

interface Followed { job: QueuedJob; state: JobState; detail: string | undefined; timer: Timer | null; unwake: (() => void) | null; reading: boolean; again: boolean; settled: boolean }

const PIPELINE_RUNNING = new Set(['running', 'awaiting_approval', 'paused_at_breakpoint']);
const PIPELINE_FAILED = new Set(['failed', 'rejected', 'cancelled', 'stuck']);

/** The job's state from the read its page uses, or null when this read says nothing new. */
async function readState(o: JobTrackerOptions, job: QueuedJob): Promise<{ state: JobState; detail?: string } | null> {
  const get = async <T>(url: string): Promise<{ status: number; body: T | null }> => {
    try {
      const res = await o.fetch(url, { credentials: 'include' });
      return { status: res.status, body: res.ok ? await res.json() as T : null };
    } catch { return { status: 0, body: null }; }
  };
  if (job.kind === 'sweep') {
    const r = await get<{ state?: JobState; detail?: string | null }>(`/api/work/sweeps/jobs/${encodeURIComponent(job.jobId)}`);
    if (r.status === 404) return { state: 'failed', detail: 'The server no longer has this job (it restarted); the findings page shows what ran.' };
    if (!r.body?.state) return null;
    return { state: r.body.state, ...(r.body.detail ? { detail: r.body.detail } : {}) };
  }
  if (job.kind === 'pipeline') {
    const r = await get<{ run?: { status?: string; error?: string | null } }>(`/api/pipelines/runs/${encodeURIComponent(job.jobId)}`);
    const status = r.body?.run?.status;
    if (!status) return null;
    if (status === 'completed') return { state: 'done', detail: 'Dry-run completed' };
    if (PIPELINE_FAILED.has(status)) return { state: 'failed', detail: r.body?.run?.error || `The run ended ${status.replace(/_/g, ' ')}` };
    if (PIPELINE_RUNNING.has(status)) return { state: 'running', ...(status === 'awaiting_approval' ? { detail: 'Waiting for an approval' } : {}) };
    return { state: 'queued' };
  }
  const r = await get<{ runs?: Array<{ id: string; status: string; outcome?: Record<string, unknown> | null }> }>(`/api/bots/${encodeURIComponent(job.botId ?? '')}/runs`);
  const run = r.body?.runs?.find((x) => x.id === job.jobId);
  if (!run) return null;
  const reason = typeof run.outcome?.['reason'] === 'string' ? run.outcome['reason'] as string : typeof run.outcome?.['error'] === 'string' ? run.outcome['error'] as string : undefined;
  if (run.status === 'done') return { state: 'done', detail: 'Run finished' };
  if (run.status === 'failed' || run.status === 'skipped') return { state: 'failed', detail: reason ?? `The run ${run.status === 'skipped' ? 'was skipped' : 'failed'}` };
  return { state: 'running' };
}

/** What the voice says when a job ends. */
export function outcomeLine(job: Pick<QueuedJob, 'title'>, state: 'done' | 'failed', detail: string | undefined): string {
  return `${job.title} ${state === 'done' ? 'finished' : 'failed'}${detail ? `: ${detail.replace(/\.$/, '')}` : ''}.`;
}

/**
 * Follows queued jobs to the end (see the module header). One per dock; a job
 * keeps its toast and its notification after the voice session ends, and
 * dispose() stops every read.
 */
export class VoiceJobTracker implements JobTracking {
  private readonly followed = new Map<string, Followed>();
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly opts: JobTrackerOptions;

  constructor(opts: JobTrackerOptions) {
    this.opts = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  track(job: QueuedJob): void {
    if (this.followed.has(job.jobId)) return;
    const f: Followed = { job, state: 'queued', detail: job.note ? `Note: ${job.note}` : undefined, timer: null, unwake: null, reading: false, again: false, settled: false };
    this.followed.set(job.jobId, f);
    this.show(f);
    f.unwake = this.opts.wake?.(job, () => { void this.read(f); }) ?? null;
    this.schedule(f);
  }

  /** The jobs still being followed (tests, and the pane's unmount). */
  active(): string[] {
    return [...this.followed.values()].filter((f) => !f.settled).map((f) => f.job.jobId);
  }

  dispose(): void {
    for (const f of this.followed.values()) this.stop(f);
    this.followed.clear();
  }

  private schedule(f: Followed): void {
    if (f.settled) return;
    if (f.timer != null) this.clearTimer(f.timer);
    f.timer = this.setTimer(() => { f.timer = null; void this.read(f).then(() => this.schedule(f)); }, this.opts.pollMs ?? JOB_POLL_MS);
  }

  private stop(f: Followed): void {
    if (f.timer != null) this.clearTimer(f.timer);
    f.timer = null;
    f.unwake?.();
    f.unwake = null;
  }

  private async read(f: Followed): Promise<void> {
    if (f.settled) return;
    if (f.reading) { f.again = true; return; }
    f.reading = true;
    try {
      const next = await readState(this.opts, f.job);
      if (next && !f.settled && (next.state !== f.state || next.detail !== f.detail)) {
        // A job never moves backwards on the toast (a stale read after a newer event).
        if (rank(next.state) >= rank(f.state)) {
          f.state = next.state;
          f.detail = next.detail ?? (f.job.note ? `Note: ${f.job.note}` : undefined);
          this.show(f);
        }
      }
    } finally {
      f.reading = false;
    }
    if (f.again && !f.settled) { f.again = false; await this.read(f); }
  }

  private show(f: Followed): void {
    const { job } = f;
    const terminal = f.state === 'done' || f.state === 'failed';
    if (terminal) { f.settled = true; this.stop(f); }
    this.opts.toast.toastJob({
      id: job.jobId, title: job.title, state: f.state,
      ...(f.detail ? { detail: f.detail } : {}),
      href: job.href, hrefLabel: 'Open',
      dismissAfterMs: Math.max(1, this.opts.toastSeconds() || DEFAULT_TOAST_SECONDS) * 1000,
      onSettled: (s) => {
        const notice: JobNotice = { jobId: job.jobId, kind: job.kind, title: job.title, state: s.state, href: job.href, ...(s.detail ? { detail: s.detail } : {}) };
        this.opts.notify(notice);
        this.opts.speak(outcomeLine(job, s.state, s.detail));
      },
    });
  }
}

const rank = (s: JobState): number => (s === 'queued' ? 0 : s === 'running' ? 1 : 2);

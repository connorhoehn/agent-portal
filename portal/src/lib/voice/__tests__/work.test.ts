// queue_work (G19): the scripted session queues background work, one keyed
// toast follows the server's job id through queued -> running -> done, leaves
// after VOICE_TOAST_SECONDS, the notification center keeps the entry and the
// voice says the outcome; a cancel sends nothing, a role without the page
// button's action is refused before any request, and the model can never name
// the job the toast follows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { ResultMemory, runPreparedCall, planPreparedCall, prepareToolCall } from '../tools.ts';
import { SPOKEN_DETAIL_MAX, VoiceJobTracker, jobNotification, matchByName, outcomeLine, resolveSweep, type JobToastSink, type JobState } from '../work.ts';
import { addLocalNotification, clearLocalNotifications, getLocalNotifications, mergeNotifications } from '../../localNotifications.ts';
import { FakeClock, fakeFetch, isToolRow, middlewareVoice, route, toolContext, type Route, type LoggedRequest } from './voiceHarness.ts';
import type { Action } from '../../capabilities';
import { deriveInstruction } from '../../../pages/project-detail/prepareJobModel.ts';

type Call = { name: string; arguments: Record<string, unknown>; said: string };
const SESSION = 'vs_00000000-0000-0000-0000-0000000000cc';
const SERVER_JOB = 'sweepjob-0f9e-server';

interface Toasted { id: string; title: string; state: JobState; detail?: string; href?: string; dismissAfterMs?: number }

/** The library's toastJob contract on the virtual clock: same id updates in place; a settled toast leaves dismissAfterMs later; onSettled once. */
function fakeToasts(clock: FakeClock) {
  const calls: Toasted[] = [];
  const shown = new Map<string, JobState>();
  const settled = new Set<string>();
  const sink: JobToastSink = {
    toastJob(o) {
      calls.push({ id: o.id, title: o.title, state: o.state, ...(o.detail ? { detail: o.detail } : {}), ...(o.href ? { href: o.href } : {}), ...(o.dismissAfterMs ? { dismissAfterMs: o.dismissAfterMs } : {}) });
      shown.set(o.id, o.state);
      if ((o.state === 'done' || o.state === 'failed') && !settled.has(o.id)) {
        settled.add(o.id);
        clock.setTimer(() => { shown.delete(o.id); }, o.dismissAfterMs ?? 8000);
        o.onSettled?.({ id: o.id, title: o.title, state: o.state, ...(o.detail ? { detail: o.detail } : {}), ...(o.href ? { href: o.href } : {}) });
      }
    },
    dismissJobToast(id) { shown.delete(id); },
  };
  return { calls, shown, sink };
}

/** A sweep job whose state advances one step per read: queued, running, done. */
function sweepJobRoute(jobId: string, final: { state: JobState; detail: string } = { state: 'done', detail: '6 findings' }): Route {
  let reads = 0;
  return (req) => {
    if (req.method !== 'GET' || req.url !== `/api/work/sweeps/jobs/${jobId}`) return undefined;
    reads += 1;
    const body = reads === 1 ? { jobId, state: 'queued', detail: null } : reads === 2 ? { jobId, state: 'running', detail: null } : { jobId, ...final };
    return { status: 200, body };
  };
}

async function scripted(opts: { role?: string; allow?: Action[]; deny?: Action[]; routes?: Route[]; call?: Call; tenant?: string; toastSeconds?: number }) {
  const { mockCallFor } = await middlewareVoice<{ mockCallFor: (t: string, r: string) => Call }>('catalogue.ts');
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const tenant = opts.tenant ?? 'orgiq';
  const role = opts.role ?? 'program-owner';
  const call = opts.call ?? mockCallFor(tenant, role);
  const body = {
    sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
    model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    ...(opts.toastSeconds ? { toastSeconds: opts.toastSeconds } : {}),
    mockScript: mockLiveScript(SESSION, call),
  };
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    ...(opts.routes ?? []),
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, body),
  ]);
  const toasts = fakeToasts(clock);
  clearLocalNotifications();
  const wakers: Array<() => void> = [];
  let controller: VoiceController | null = null;
  const jobs = new VoiceJobTracker({
    fetch, toast: toasts.sink,
    notify: (n) => addLocalNotification(jobNotification(n, tenant, new Date('2026-11-08T12:05:00Z'))),
    speak: (line) => controller?.noteJobOutcome(line),
    toastSeconds: () => controller?.toastSeconds() ?? 8,
    wake: (_job, onEvent) => { wakers.push(onEvent); return () => { wakers.splice(wakers.indexOf(onEvent), 1); }; },
    pollMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const ctx = toolContext({
    fetch, tenant, role, results: new ResultMemory(), jobs,
    ...(opts.allow ? { allow: opts.allow } : {}), ...(opts.deny ? { deny: opts.deny } : {}),
  });
  controller = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await controller.start();
  await clock.advance(1500);
  return { controller, clock, log, toasts, jobs, wakers, call };
}

async function stop(s: { controller: VoiceController; clock: FakeClock }): Promise<void> {
  const stopping = s.controller.stop();
  await s.clock.advance(300);
  await stopping;
}

const posts = (log: LoggedRequest[], prefix: string) => log.filter((r) => r.method === 'POST' && r.url.startsWith(prefix));
const reads = (log: LoggedRequest[]) => log.filter((r) => !r.url.startsWith('/api/voice/'));
const toolRows = (log: LoggedRequest[]) => log.filter((r) => isToolRow(r)).map((r) => r.body as Record<string, unknown>);

test('the program owner\'s scripted session queues the nightly sweep, and one toast follows the server\'s job to done, then leaves', async () => {
  const s = await scripted({
    toastSeconds: 5,
    routes: [
      route('POST', '/api/work/sweeps/run', 202, { jobId: SERVER_JOB, kind: 'sweep', sweep: null, title: 'The nightly org sweeps', state: 'queued', href: '/iq/work/findings' }),
      sweepJobRoute(SERVER_JOB),
    ],
  });
  assert.equal(s.call.name, 'queue_work', 'orgiq/program-owner scripts queue_work');
  const card = s.controller.getSnapshot().pending;
  assert.equal(card?.tool, 'queue_work');
  assert.equal(card?.title, 'Run the nightly org sweeps now');
  assert.match(String(card?.detail ?? ''), /spends nothing/);
  assert.equal(posts(s.log, '/api/work').length, 0, 'nothing is queued before the confirm');

  s.controller.confirm('click');
  await s.clock.advance(200);
  const sent = posts(s.log, '/api/work/sweeps/run');
  assert.deepEqual(sent.map((r) => r.body), [{ background: true }], 'all sweeps, background, nothing the model said');
  assert.deepEqual(s.toasts.calls.map((c) => c.state), ['queued']);
  assert.equal(s.toasts.calls[0]!.id, SERVER_JOB, 'the toast is keyed on the server\'s id');
  assert.equal(s.toasts.calls[0]!.dismissAfterMs, 5000, 'VOICE_TOAST_SECONDS from the mint');

  // The stream wakes a read; the poll takes it on to running and done.
  s.wakers[0]!();
  await s.clock.advance(50);
  for (let i = 0; i < 60 && s.toasts.shown.get(SERVER_JOB) !== 'done'; i++) await s.clock.advance(100);
  assert.deepEqual(s.toasts.calls.map((c) => c.state), ['queued', 'running', 'done']);
  assert.ok(s.toasts.calls.every((c) => c.id === SERVER_JOB), 'one toast, updated in place');
  const last = s.toasts.calls.at(-1)!;
  assert.equal(last.detail, '6 findings');
  assert.equal(last.href, '/iq/work/findings', 'done carries the result link');
  assert.equal(s.toasts.shown.get(SERVER_JOB), 'done');
  assert.deepEqual(s.jobs.active(), [], 'reads stop at the terminal state');
  assert.equal(s.wakers.length, 0, 'the stream is let go');

  // The notification center holds the entry; the voice said it.
  const entries = getLocalNotifications();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, `voice-job:${SERVER_JOB}`);
  assert.equal(entries[0]!.title, 'The nightly org sweeps finished');
  assert.equal(entries[0]!.action?.href, '/iq/work/findings');
  assert.equal(entries[0]!.payload?.['tenant'], 'orgiq');
  const said = s.controller.getSnapshot().turns.map((t) => t.text);
  assert.ok(said.includes('The nightly org sweeps finished: 6 findings.'), said.join(' | '));

  // The toast leaves after the timer; the entry stays.
  await s.clock.advance(4800);
  assert.equal(s.toasts.shown.has(SERVER_JOB), true, 'still up just before the timer');
  await s.clock.advance(300);
  assert.equal(s.toasts.shown.has(SERVER_JOB), false, 'gone after VOICE_TOAST_SECONDS');
  assert.equal(getLocalNotifications().length, 1);

  // The voice_tool_calls row: done, confirmed by click; the model saw the server's id.
  const rows = toolRows(s.log);
  assert.deepEqual(rows.map((r) => [r['tool'], r['outcome'], r['confirmedBy']]), [['queue_work', 'done', 'click']]);
  const reads200 = s.log.filter((r) => r.url === `/api/work/sweeps/jobs/${SERVER_JOB}`).length;
  await s.clock.advance(5000);
  assert.equal(s.log.filter((r) => r.url === `/api/work/sweeps/jobs/${SERVER_JOB}`).length, reads200, 'no reads after the end');
  await stop(s);
});

test('a sweep already running (409 sweep-job-running): the runner follows that job\'s toast and says nothing new was queued, instead of failing', async () => {
  const RUNNING = 'sweepjob-already-running';
  const s = await scripted({
    routes: [
      route('POST', '/api/work/sweeps/run', 409, {
        error: 'a background sweep you started is still running', code: 'sweep-job-running', jobId: RUNNING,
        job: { jobId: RUNNING, kind: 'sweep', sweep: 'stale_docs', title: 'server title', state: 'running', detail: null, href: 'https://evil.example/x' },
      }),
      sweepJobRoute(RUNNING, { state: 'done', detail: '2 stale docs' }),
    ],
  });
  s.controller.confirm('click');
  await s.clock.advance(200);
  assert.equal(posts(s.log, '/api/work/sweeps/run').length, 1, 'one request; no retry');
  assert.equal(s.toasts.calls[0]?.id, RUNNING, 'the toast follows the running job');
  assert.equal(s.toasts.calls[0]?.title, 'The stale docs sweep');
  assert.equal(s.toasts.calls[0]?.href, '/iq/work/findings', 'an off-portal href is never followed');
  const call = s.controller.getSnapshot().turns.flatMap((t) => t.toolCalls ?? []).find((c) => c.name === 'queue_work');
  assert.equal(call?.status, 'done');
  assert.match(call?.summary ?? '', /already running/);
  for (let i = 0; i < 60 && s.toasts.shown.get(RUNNING) !== 'done'; i++) await s.clock.advance(100);
  assert.equal(s.toasts.shown.get(RUNNING), 'done');
  assert.ok(s.controller.getSnapshot().turns.some((t) => t.text === 'The stale docs sweep finished: 2 stale docs.'));
  assert.deepEqual(toolRows(s.log).map((r) => [r['tool'], r['outcome']]), [['queue_work', 'done']]);
  await stop(s);
});

test('a job\'s spoken outcome keeps the server\'s detail to one line of at most 120 characters', () => {
  const long = `Traceback (most recent call last):\n  File "x.py", line 1\n${'boom '.repeat(80)}`;
  const line = outcomeLine({ title: 'The nightly org sweeps' }, 'failed', long);
  const detail = line.slice('The nightly org sweeps failed: '.length, -1);
  assert.equal(SPOKEN_DETAIL_MAX, 120);
  assert.ok(detail.length <= SPOKEN_DETAIL_MAX, `${detail.length}`);
  assert.doesNotMatch(line, /\n/);
  assert.match(detail, /…$/);
  assert.equal(outcomeLine({ title: 'A' }, 'done', '6 findings.'), 'A finished: 6 findings.');
});

test('a cancelled card sends nothing: no queue request, no toast, no entry', async () => {
  const s = await scripted({ routes: [route('POST', '/api/work/sweeps/run', 202, { jobId: SERVER_JOB })] });
  assert.equal(s.controller.getSnapshot().pending?.tool, 'queue_work');
  s.controller.cancel('click');
  await s.clock.advance(3000);
  assert.deepEqual(reads(s.log), [], 'a sweep card needs no read and the cancel sent nothing');
  assert.equal(s.toasts.calls.length, 0);
  assert.equal(getLocalNotifications().length, 0);
  assert.deepEqual(toolRows(s.log).map((r) => [r['tool'], r['outcome']]), [['queue_work', 'cancelled']]);
  await stop(s);
});

test('a role without the page button\'s action is refused before any request, and so is a kind from another workspace', async () => {
  const noGate = await scripted({ deny: ['DispatchAgentRun'] });
  assert.equal(noGate.controller.getSnapshot().pending, null, 'no card');
  assert.deepEqual(reads(noGate.log), [], 'refused offline');
  const call = noGate.controller.getSnapshot().turns.flatMap((t) => t.toolCalls ?? []).find((c) => c.name === 'queue_work');
  assert.equal(call?.status, 'refused');
  assert.match(call?.summary ?? '', /can't run the org sweeps with your role/);
  await stop(noGate);

  const elsewhere = await scripted({ call: { name: 'queue_work', arguments: { kind: 'pipeline', target: 'nightly ingest', note: null }, said: 'Dry-run the nightly ingest.' } });
  assert.deepEqual(reads(elsewhere.log), []);
  const refusedCall = elsewhere.controller.getSnapshot().turns.flatMap((t) => t.toolCalls ?? []).find((c) => c.name === 'queue_work');
  assert.match(refusedCall?.summary ?? '', /Pipelines workspace/);
  await stop(elsewhere);
});

test('the model cannot name the job: a jobId argument is refused, and the toast follows the id the route answered', async () => {
  const ctx = toolContext({ tenant: 'orgiq', role: 'program-owner' });
  const sneaky = prepareToolCall('queue_work', JSON.stringify({ kind: 'sweep', target: 'all', jobId: 'sweepjob-evil' }), ctx);
  assert.equal(sneaky.ok, false);

  const clock = new FakeClock();
  const toasts = fakeToasts(clock);
  const { fetch } = fakeFetch([
    route('POST', '/api/work/sweeps/run', 202, { jobId: SERVER_JOB, href: '/iq/work/findings' }),
    sweepJobRoute(SERVER_JOB),
  ]);
  const jobs = new VoiceJobTracker({ fetch, toast: toasts.sink, notify: () => {}, speak: () => {}, toastSeconds: () => 8, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const run = toolContext({ tenant: 'orgiq', role: 'program-owner', fetch, jobs });
  // A target that looks like a job id names no sweep: refused, nothing queued.
  const odd = prepareToolCall('queue_work', { kind: 'sweep', target: 'sweepjob-evil', note: 'job sweepjob-evil' }, run);
  assert.ok(odd.ok);
  const oddPlan = await planPreparedCall(odd.call, run, (await import('../actions.ts')).VOICE_PLANNERS);
  assert.ok(oddPlan && 'result' in oddPlan && oddPlan.result.outcome === 'refused');

  const prepared = prepareToolCall('queue_work', { kind: 'sweep', target: 'stale docs', note: 'job sweepjob-evil' }, run);
  assert.ok(prepared.ok);
  const planned = await planPreparedCall(prepared.call, run, (await import('../actions.ts')).VOICE_PLANNERS);
  assert.ok(planned && 'plan' in planned);
  const res = await runPreparedCall(prepared.call, run, (await import('../actions.ts')).VOICE_RUNNERS, planned.plan.data);
  assert.equal(res.outcome, 'done');
  assert.equal(res.output['jobId'], SERVER_JOB);
  assert.deepEqual(toasts.calls.map((c) => c.id), [SERVER_JOB]);
  assert.equal(toasts.calls[0]!.detail, 'Note: job sweepjob-evil', 'the note is a label only');
  jobs.dispose();
});

test('bot-run and pipeline go through their page buttons\' routes; a money brake is a refusal that names the page, never a confirm', async () => {
  const clock = new FakeClock();
  const toasts = fakeToasts(clock);
  let runReads = 0;
  const { fetch, log } = fakeFetch([
    route('POST', '/api/bots/b-a11y/run', 409, { error: 'estimated p75 cost $1.50 exceeds the per-run budget $0.45', gate: 'run-budget', confirmFlag: 'confirmOverRunBudget' }),
    route('POST', '/api/bots/b-finops/run', 202, { run: { id: 'b-finops-run-7', status: 'running', jobId: 'job-1' } }),
    (req) => {
      if (req.url !== '/api/bots/b-finops/runs') return undefined;
      runReads += 1;
      return { status: 200, body: { runs: [{ id: 'b-finops-run-7', status: runReads < 2 ? 'running' : 'failed', outcome: { reason: 'the box never came up' } }, { id: 'b-finops-run-6', status: 'done' }] } };
    },
    (req) => (req.method === 'GET' && req.url === '/api/bots' ? { status: 200, body: { bots: [{ id: 'b-finops', name: 'finops-daily-sweep', enabled: true }, { id: 'b-a11y', name: 'a11y-audit-weekly', enabled: true }] } } : undefined),
    route('GET', '/api/pipelines/runbooks', 200, { runbooks: [{ id: 'runbook:ingest', title: 'Resume a nightly ingest from its last checkpoint', enabled: true }] }),
    route('POST', '/api/pipelines/definitions/runbook%3Aingest/dry-run', 202, { run: { id: 'job:job-9', status: 'pending' }, jobId: 'job-9' }),
    route('GET', '/api/pipelines/runs/job%3Ajob-9', 200, { run: { id: 'job:job-9', status: 'completed' } }),
  ]);
  const notices: string[] = [];
  const jobs = new VoiceJobTracker({ fetch, toast: toasts.sink, notify: (n) => notices.push(`${n.jobId}:${n.state}`), speak: () => {}, toastSeconds: () => 8, pollMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const { VOICE_PLANNERS, VOICE_RUNNERS } = await import('../actions.ts');
  const run = async (tenant: string, args: Record<string, unknown>) => {
    const ctx = toolContext({ tenant, role: tenant === 'orgiq' ? 'program-owner' : 'operator', fetch, jobs });
    const p = prepareToolCall('queue_work', args, ctx);
    assert.ok(p.ok, JSON.stringify(p));
    const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
    if (planned && 'result' in planned) return { planned };
    return { planned, res: await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned!.plan.data) };
  };

  const braked = await run('orgiq', { kind: 'bot-run', target: 'a11y audit weekly' });
  assert.equal(braked.res?.outcome, 'refused');
  assert.match(braked.res?.summary ?? '', /needs a confirm on its page, not by voice: estimated p75 cost \$1\.50 exceeds the per-run budget/);
  assert.deepEqual(posts(log, '/api/bots/b-a11y/run').map((r) => r.body), [{}], 'no confirm flag is ever sent');

  const ambiguous = await run('orgiq', { kind: 'bot-run', target: 'bot' });
  assert.ok(ambiguous.planned && 'result' in ambiguous.planned && ambiguous.planned.result.outcome === 'refused');

  const bot = await run('orgiq', { kind: 'bot-run', target: 'finops daily sweep', note: 'run before standup' });
  assert.equal(bot.planned && 'plan' in bot.planned ? bot.planned.plan.title : null, 'Run the finops-daily-sweep bot now');
  assert.deepEqual(posts(log, '/api/bots/b-finops/run').map((r) => r.body), [{}], 'the note is never sent as an instruction');
  assert.equal(bot.res?.output['jobId'], 'b-finops-run-7');

  const dry = await run('pipelines', { kind: 'pipeline', target: 'nightly ingest' });
  assert.equal(dry.res?.output['href'], '/pipelines/runs/job%3Ajob-9');

  await clock.advance(3000);
  const byId = (id: string) => toasts.calls.filter((c) => c.id === id).map((c) => c.state);
  assert.deepEqual(byId('b-finops-run-7'), ['queued', 'running', 'failed']);
  assert.equal(toasts.calls.filter((c) => c.id === 'b-finops-run-7').at(-1)!.detail, 'the box never came up', 'failed carries the error');
  assert.deepEqual(byId('job:job-9'), ['queued', 'done']);
  assert.deepEqual(notices.sort(), ['b-finops-run-7:failed', 'job:job-9:done']);
  jobs.dispose();
});

test('target resolution: sweep words and bot or runbook names', () => {
  assert.equal(resolveSweep('nightly sweep'), null);
  assert.equal(resolveSweep('all of them'), null);
  assert.equal(resolveSweep('the stale docs sweep'), 'stale_docs');
  assert.equal(resolveSweep('bus_factor'), 'bus_factor');
  assert.equal(resolveSweep('vibes'), undefined);
  assert.equal(resolveSweep('stale docs and orphan decisions'), undefined, 'two named sweeps is not one');
  const bots = [{ name: 'finops-daily-sweep' }, { name: 'llm-evals-nightly' }, { name: 'inference-canary-nightly' }];
  assert.deepEqual(matchByName(bots, (b) => b.name, 'the finops bot').map((b) => b.name), ['finops-daily-sweep']);
  assert.deepEqual(matchByName(bots, (b) => b.name, 'nightly').map((b) => b.name), ['llm-evals-nightly', 'inference-canary-nightly']);
  assert.deepEqual(matchByName(bots, (b) => b.name, 'bot'), []);
});

test('the notification center merges the portal\'s entries with the gateway inbox; each verb reaches the list that holds the id', () => {
  clearLocalNotifications();
  const marked: string[] = [];
  const remote = {
    notifications: [{ id: 'g1', type: 'mention' as const, title: 'Mention', timestamp: '2026-11-08T12:00:00Z' }],
    unreadCount: 1,
    markAsRead: (id: string) => { marked.push(id); }, markAllRead: () => { marked.push('*'); }, remove: () => {}, clearAll: () => {},
  };
  addLocalNotification(jobNotification({ jobId: 'j1', kind: 'sweep', title: 'The stale docs sweep', state: 'done', detail: '2 findings', href: '/iq/work/findings' }, 'orgiq', new Date('2026-11-08T12:01:00Z')));
  const merged = mergeNotifications(remote, getLocalNotifications());
  assert.deepEqual(merged.notifications.map((n) => n.id), ['g1', 'voice-job:j1']);
  assert.equal(merged.unreadCount, 2);
  merged.markAsRead('voice-job:j1');
  assert.deepEqual(marked, [], 'a local mark stays local');
  assert.equal(getLocalNotifications()[0]!.read, true);
  merged.markAsRead('g1');
  assert.deepEqual(marked, ['g1']);
  clearLocalNotifications();
});

// ── catalogue v2 (V2-9): every new kind through its page button's route, one toast each ──

/** A read that answers `bodies` in turn (the last one again after), so a follower moves queued, running, done. */
const steps = (url: string, bodies: unknown[]): Route => {
  let n = 0;
  return (req) => (req.method === 'GET' && req.url === url ? { status: 200, body: bodies[Math.min(n++, bodies.length - 1)] } : undefined);
};

interface KindCase {
  kind: string; tenant: string; allow: Action[]; target: string; model?: string;
  routes: Route[]; post: [string, unknown]; title: string; states: JobState[]; href: string; toastId?: string;
}

const PROJECTS = [{ id: 'p-auth', name: 'Auth Migration' }, { id: 'p-obs', name: 'Observability Platform' }];
/** The initiative page's own reads (G22): its work tree, its detail (the linked repo), the codebases that deliver it. */
const CODEBASE = '11111111-2222-4333-8444-555555555555';
const RETRY_STORM = { id: 'w-9', type: 'story', title: 'Fix the retry storm', status: 'open', priority: 'high', storyPoints: 3, children: [] };
const INITIATIVE_READS: Route[] = [
  route('GET', '/api/graph/projects/p-auth/work', 200, [{ id: 'e-1', type: 'epic', title: 'Resilience', children: [RETRY_STORM] }]),
  route('GET', '/api/graph/projects/p-auth', 200, { id: 'p-auth', name: 'Auth Migration', repoFullName: 'acme/auth' }),
  route('GET', '/api/agent-projects', 200, { projects: [{ id: CODEBASE, repoFullName: 'acme/auth', orgProjectId: 'p-auth' }] }),
];
const TEAMS = [{ id: 'TEAM-001', name: 'Northstar Payments' }, { id: 'TEAM-002', name: 'Kubernetes Operator' }];
const CASES: KindCase[] = [
  { kind: 'job', tenant: 'orgiq', allow: ['ManageDevbox'], target: 'login redirect',
    routes: [route('GET', '/api/work/suggestions', 200, { suggestions: [{ id: 'sg-w1', title: 'Fix the login redirect', prompt: 'Fix the redirect loop on /login (w1).', initiativeName: 'Auth Migration' }, { id: 'sg-w2', title: 'Write the runbook', prompt: 'p' }] }),
      route('POST', '/api/work/jobs', 201, { id: 'job-41', status: 'queued' }),
      steps('/api/work/jobs/job-41', [{ id: 'job-41', status: 'running' }, { id: 'job-41', status: 'awaiting_review' }])],
    post: ['/api/work/jobs', { title: 'Fix the login redirect', prompt: 'Fix the redirect loop on /login (w1).', suggestionId: 'sg-w1' }],
    title: 'Queue "Fix the login redirect"', states: ['queued', 'running', 'done'], href: '/iq/work/job-41' },
  { kind: 'dispatch', tenant: 'orgiq', allow: ['DispatchAgentRun'], target: 'retry storm', model: 'sonnet',
    routes: [route('GET', '/api/graph/work', 200, [{ id: 'w-9', title: 'Fix the retry storm', projectId: 'p-auth', storyPoints: 3 }]),
      ...INITIATIVE_READS,
      route('GET', '/api/bots/estimate', 200, { costUsdP25: 0.4, costUsdP75: 1.25, confidence: 'medium' }),
      route('POST', '/api/bots/dispatch-work', 202, { run: { id: 'run-5', jobId: 'job-55' } }),
      steps('/api/work/jobs/job-55', [{ status: 'claimed' }, { status: 'running' }, { status: 'done', result: { summary: 'Opened a PR' } }])],
    // The drawer's own body (prepareJobModel.ts dispatchBody): the named model, the initiative's codebase, the item's instruction.
    post: ['/api/bots/dispatch-work', { workItemId: 'w-9', model: 'us.anthropic.claude-sonnet-5', agentProjectId: CODEBASE, instruction: deriveInstruction({ ...RETRY_STORM, summary: null, description: null, nextStep: null, nextStepDetail: null }) }],
    title: 'Dispatch "Fix the retry storm"', states: ['queued', 'running', 'done'], href: '/iq/work/job-55' },
  { kind: 'finding-promote', tenant: 'orgiq', allow: ['DispatchAgentRun'], target: 'stale onboarding doc',
    routes: [route('GET', '/api/work/findings', 200, { findings: [{ id: 'f-3', title: 'Stale onboarding doc', status: 'open' }] }),
      route('POST', '/api/work/findings/f-3/promote', 201, { id: 'job-60' }), steps('/api/work/jobs/job-60', [{ status: 'running' }, { status: 'done' }])],
    post: ['/api/work/findings/f-3/promote', {}], title: 'Turn "Stale onboarding doc" into a job', states: ['queued', 'running', 'done'], href: '/iq/work/job-60' },
  { kind: 'finding-analyze', tenant: 'orgiq', allow: ['DispatchAgentRun'], target: 'stale onboarding doc',
    routes: [route('GET', '/api/work/findings', 200, { findings: [{ id: 'f-3', title: 'Stale onboarding doc', status: 'open' }] }),
      route('POST', '/api/work/findings/f-3/analyze', 200, { links: [1, 2], proposals: [1], problem: 'x' })],
    post: ['/api/work/findings/f-3/analyze', {}], title: 'Analyse "Stale onboarding doc"', states: ['done'], href: '/iq/work/findings' },
  { kind: 'change-rereview', tenant: 'orgiq', allow: ['RunDevboxTask', 'ManageDevbox'], target: 'tighten retries',
    routes: [route('GET', '/api/sdlc/changes', 200, { changes: [{ id: 'cr-1', title: 'Tighten retries', status: 'changes_requested' }] }),
      route('POST', '/api/sdlc/changes/cr-1/rereview', 200, { ok: true, verdict: 'approve', status: 'needs_approval' })],
    post: ['/api/sdlc/changes/cr-1/rereview', {}], title: 'Re-review "Tighten retries"', states: ['done'], href: '/admin/changes/cr-1' },
  { kind: 'change-address', tenant: 'orgiq', allow: ['RunDevboxTask', 'ManageDevbox'], target: 'tighten retries',
    routes: [steps('/api/sdlc/changes/cr-1', [{ change: { status: 'changes_requested' } }, { change: { status: 'needs_approval' } }]),
      route('GET', '/api/sdlc/changes', 200, { changes: [{ id: 'cr-1', title: 'Tighten retries', status: 'changes_requested' }] }),
      route('POST', '/api/sdlc/changes/cr-1/address', 202, { ok: true, runId: 'arun-1' })],
    post: ['/api/sdlc/changes/cr-1/address', {}], title: 'Address the review on "Tighten retries"', states: ['queued', 'running', 'done'], href: '/admin/changes/cr-1' },
  { kind: 'deck', tenant: 'orgiq', allow: ['DispatchAgentRun'], target: 'auth migration',
    routes: [route('GET', '/api/graph/projects', 200, PROJECTS), route('POST', '/api/initiative-decks/projects/p-auth', 201, { deckId: 'idk-1', revisionId: 'r1' })],
    post: ['/api/initiative-decks/projects/p-auth', {}], title: 'Build a status deck for Auth Migration', states: ['done'], href: '/iq/decks/idk-1' },
  { kind: 'summarize', tenant: 'orgiq', allow: [], target: 'observability',
    routes: [route('GET', '/api/graph/projects', 200, PROJECTS), route('POST', '/api/conversations/summarize/run', 202, { runId: 'sum-1' }),
      steps('/api/conversations/summarize/runs/sum-1', [{ phase: 'running' }, { phase: 'completed' }])],
    post: ['/api/conversations/summarize/run', { channel: 'orgiq:initiative:p-obs', text: '' }], title: 'Summarise Observability Platform', states: ['queued', 'running', 'done'], href: '/iq/projects/p-obs' },
  // G35: the document job's toast lands on the initiative (where the draft's Save card is), an in-app path the
  // pane routes through the router (the toast's onNavigate, ui-components 2.514.1), never a full page load.
  { kind: 'doc', tenant: 'orgiq', allow: [], target: 'observability',
    routes: [route('GET', '/api/graph/projects', 200, PROJECTS), route('POST', '/api/conversations/doc/run', 202, { runId: 'doc-1' }),
      steps('/api/conversations/doc/runs/doc-1', [{ phase: 'running' }, { phase: 'completed' }])],
    post: ['/api/conversations/doc/run', { channel: 'orgiq:initiative:p-obs', text: '' }], title: 'Draft a document from Observability Platform', states: ['queued', 'running', 'done'], href: '/iq/projects/p-obs' },
  { kind: 'diagram', tenant: 'social', allow: ['ViewSocial'], target: 'platform',
    routes: [route('GET', '/api/social/resolve?kind=channel', 200, { kind: 'channel', match: { id: 'platform', name: 'platform', channel: 'social:ch:platform', channelId: 'x' }, candidates: [] }),
      route('POST', '/api/chat/commands/diagram/run', 202, { runId: 'dia-1' }), steps('/api/chat/commands/diagram/runs/dia-1', [{ phase: 'completed' }])],
    post: ['/api/chat/commands/diagram/run', { channel: 'social:ch:platform', text: '' }], title: 'Draw a diagram of #platform', states: ['queued', 'done'], href: '/social/channels/platform' },
  { kind: 'deck', tenant: 'social', allow: ['ViewSocial'], target: 'platform',
    routes: [route('GET', '/api/social/resolve?kind=channel', 200, { kind: 'channel', match: { id: 'platform', name: 'platform', channel: 'social:ch:platform', channelId: 'x' }, candidates: [] }),
      route('POST', '/api/chat/commands/deck/run', 202, { runId: 'deck-1' }), steps('/api/chat/commands/deck/runs/deck-1', [{ phase: 'running' }, { phase: 'failed', error: 'No readable messages' }])],
    post: ['/api/chat/commands/deck/run', { channel: 'social:ch:platform', text: '' }], title: 'Build a deck from #platform', states: ['queued', 'running', 'failed'], href: '/social/channels/platform' },
  { kind: 'assessment-run', tenant: 'assessment', allow: ['ViewAssessment', 'RunAssessmentAgent'], target: 'northstar',
    routes: [route('GET', '/api/assessment/teams', 200, TEAMS), route('POST', '/api/assessment/runs', 202, { run_id: 'arun-9' }),
      steps('/api/assessment/runs/arun-9', [{ status: 'running' }, { status: 'completed' }])],
    post: ['/api/assessment/runs', { command: 'score-dimensions', args: { team: 'TEAM-001' }, team_id: 'TEAM-001' }], title: 'Run the scorer on Northstar Payments', states: ['queued', 'running', 'done'], href: '/assessment/runs/arun-9' },
  { kind: 'draft-followups', tenant: 'assessment', allow: ['ViewAssessment', 'RunAssessmentAgent'], target: 'continuous integration for northstar',
    routes: [route('GET', '/api/assessment/teams/TEAM-001', 200, { team: TEAMS[0], dimensions: [{ id: '1', title: 'Continuous Integration (CI)' }, { id: '2', title: 'Continuous Delivery' }] }),
      route('GET', '/api/assessment/teams', 200, TEAMS),
      route('POST', '/api/assessment/teams/TEAM-001/dimensions/1/drafts/followups', 202, { runId: 'adr-1' }), steps('/api/assessment/drafts/adr-1', [{ phase: 'completed' }])],
    post: ['/api/assessment/teams/TEAM-001/dimensions/1/drafts/followups', {}], title: 'Draft follow-ups for Continuous Integration (CI) (Northstar Payments)', states: ['queued', 'done'], href: '/assessment/teams/TEAM-001' },
  { kind: 'deck', tenant: 'assessment', allow: ['ViewAssessment', 'RunAssessmentAgent'], target: 'kubernetes',
    routes: [route('GET', '/api/assessment/teams', 200, TEAMS), route('POST', '/api/assessment/teams/TEAM-002/decks', 202, { deckId: 'adk-7', runId: 'arun-7' }),
      steps('/api/assessment/runs/arun-7', [{ status: 'completed' }])],
    post: ['/api/assessment/teams/TEAM-002/decks', {}], title: 'Build a review deck for Kubernetes Operator', states: ['queued', 'done'], href: '/assessment/decks/adk-7' },
  { kind: 'deck', tenant: 'pipelines', allow: ['ViewPipelines', 'RunPipeline'], target: 'nightly',
    routes: [route('GET', '/api/pipelines/runs', 200, { runs: [{ id: 'run-42', definitionId: 'runbook:nightly', status: 'failed' }] }),
      route('POST', '/api/pipelines/runs/run-42/decks', 201, { deckId: 'pdk-2' })],
    post: ['/api/pipelines/runs/run-42/decks', {}], title: 'Build a report deck for runbook:nightly', states: ['done'], href: '/pipelines/decks/pdk-2' },
];

async function kindRun(c: KindCase, opts: { deny?: Action[] } = {}) {
  const clock = new FakeClock();
  const toasts = fakeToasts(clock);
  const { fetch, log } = fakeFetch(c.routes);
  const notices: string[] = [];
  const jobs = new VoiceJobTracker({ fetch, toast: toasts.sink, notify: (n) => notices.push(`${n.kind}:${n.state}`), speak: () => {}, toastSeconds: () => 8, pollMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const ctx = toolContext({ tenant: c.tenant, role: 'tester', fetch, jobs, ...(opts.deny ? { deny: opts.deny } : { allow: c.allow }) });
  const { VOICE_PLANNERS, VOICE_RUNNERS } = await import('../actions.ts');
  const args = { kind: c.kind, target: c.target, ...(c.model ? { model: c.model } : {}) };
  const p = prepareToolCall('queue_work', args, ctx);
  assert.ok(p.ok, `${c.kind} prepares`);
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  const before = log.filter((r) => r.method !== 'GET').length;
  if (!planned || 'result' in planned) return { planned, log, toasts, notices, before, res: null, again: null, jobs, clock };
  const res = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data);
  await clock.advance(5000);
  const again = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data);
  jobs.dispose();
  return { planned, log, toasts, notices, before, res, again, jobs, clock };
}

test('V2-9: every new kind resolves its target by the page\'s own read, asks first, sends the page button\'s route and body once, and one toast follows it', async () => {
  for (const c of CASES) {
    const where = `${c.tenant}/${c.kind}`;
    const r = await kindRun(c);
    assert.ok(r.planned && 'plan' in r.planned, `${where} shows a card: ${JSON.stringify(r.planned)}`);
    assert.equal(r.planned.plan.title, c.title, where);
    assert.equal(r.before, 0, `${where}: nothing is sent before the confirm`);
    assert.equal(r.res?.outcome, 'done', `${where}: ${r.res?.summary}`);
    const sent = r.log.filter((l) => l.method === 'POST');
    assert.deepEqual(sent.map((l) => [l.url, l.body]), [c.post], `${where}: the page button's route and body, once (a retry is answered from the ledger)`);
    assert.ok(r.again?.output['alreadyQueued'], `${where}: the retry says it was already queued`);
    const ids = [...new Set(r.toasts.calls.map((t) => t.id))];
    assert.equal(ids.length, 1, `${where}: one toast`);
    assert.deepEqual(r.toasts.calls.map((t) => t.state), c.states, `${where} states`);
    assert.equal(r.toasts.calls.at(-1)!.href, c.href, `${where} href`);
    assert.deepEqual(r.notices, [`${c.kind}:${c.states.at(-1)}`], `${where}: the notification center keeps it`);
  }
});

test('V2-9: the dispatch card shows the drawer\'s forecast; an unknown model is refused before any write, and a money brake names the page', async () => {
  const dispatch = CASES.find((c) => c.kind === 'dispatch')!;
  const r = await kindRun(dispatch);
  assert.ok(r.planned && 'plan' in r.planned);
  assert.deepEqual(r.planned.plan.detail, [
    'Fix the retry storm · Sonnet',
    'Profile: Auth Migration\'s own, with Sonnet as you asked and the acme/auth codebase; no per-run cap.',
    'Forecast $0.40 to $1.25.',
    'An agent runs it on a computer and spends against Auth Migration.',
  ]);
  assert.ok(r.log.some((l) => l.url === `/api/bots/estimate?model=us.anthropic.claude-sonnet-5&points=3&agentProjectId=${CODEBASE}`));
  const odd = await kindRun({ ...dispatch, model: 'gpt-9' });
  assert.ok(odd.planned && 'result' in odd.planned && /no "gpt-9" model/.test(odd.planned.result.summary));
  assert.equal(odd.log.filter((l) => l.method !== 'GET').length, 0);
  const reads = dispatch.routes.filter((r) => r({ method: 'GET', url: '/api/bots/estimate?x', body: undefined }) || ['/api/graph/work', '/api/graph/projects/p-auth/work', '/api/graph/projects/p-auth', '/api/agent-projects'].some((u) => r({ method: 'GET', url: u, body: undefined })));
  const braked = await kindRun({ ...dispatch, routes: [...reads, route('POST', '/api/bots/dispatch-work', 409, { error: 'over the allocation', gate: 'allocation', confirmFlag: 'confirmOverAllocation' })] });
  assert.equal(braked.res?.outcome, 'refused');
  assert.match(braked.res?.summary ?? '', /needs a confirm on its page, not by voice: over the allocation/);
  assert.ok(!JSON.stringify(braked.log.map((l) => l.body)).includes('confirmOver'), 'no confirm flag is ever sent');
});

test('V2-9: each kind is refused on its page button\'s action before any request; a kind from another workspace is refused too', async () => {
  for (const c of CASES) {
    const action = (await import('../catalogue.ts')).QUEUE_WORK_ACTIONS[c.tenant]![c.kind];
    if (!action) continue;
    const r = await kindRun(c, { deny: [action] });
    assert.ok(r.planned && 'result' in r.planned && r.planned.result.outcome === 'refused', `${c.tenant}/${c.kind}`);
    assert.equal(r.log.length, 0, `${c.tenant}/${c.kind}: no request`);
  }
  const elsewhere = await kindRun({ ...CASES[0]!, tenant: 'pipelines' });
  assert.ok(elsewhere.planned && 'result' in elsewhere.planned && /Work workspace/.test(elsewhere.planned.result.summary));
});

test('V2-9: a finding already promoted follows the job it names; a change not asking for changes is refused; agent-plan is not a kind', async () => {
  const promote = CASES.find((c) => c.kind === 'finding-promote')!;
  const r = await kindRun({ ...promote, routes: [promote.routes[0]!, route('POST', '/api/work/findings/f-3/promote', 409, { error: 'already promoted', jobId: 'job-12' }), steps('/api/work/jobs/job-12', [{ status: 'done' }])] });
  assert.equal(r.res?.output['queued'], false);
  assert.equal(r.res?.output['jobId'], 'job-12');
  assert.deepEqual(r.toasts.calls.map((t) => [t.id, t.state]), [['job-12', 'queued'], ['job-12', 'done']]);
  const address = CASES.find((c) => c.kind === 'change-address')!;
  const closed = await kindRun({ ...address, routes: [route('GET', '/api/sdlc/changes?', 200, { changes: [{ id: 'cr-1', title: 'Tighten retries', status: 'approved' }] })] });
  assert.ok(closed.planned && 'result' in closed.planned && /is approved/.test(closed.planned.result.summary));
  const ctx = toolContext({ tenant: 'orgiq' });
  assert.equal(prepareToolCall('queue_work', { kind: 'agent-plan', target: 'x' }, ctx).ok, false);
});

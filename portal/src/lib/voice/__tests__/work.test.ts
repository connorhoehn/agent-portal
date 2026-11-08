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
import { VoiceJobTracker, jobNotification, matchByName, resolveSweep, type JobToastSink, type JobState } from '../work.ts';
import { addLocalNotification, clearLocalNotifications, getLocalNotifications, mergeNotifications } from '../../localNotifications.ts';
import { FakeClock, fakeFetch, middlewareVoice, route, toolContext, type Route, type LoggedRequest } from './voiceHarness.ts';
import type { Action } from '../../capabilities';

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
const toolRows = (log: LoggedRequest[]) => log.filter((r) => r.url.endsWith('/events')).map((r) => r.body as Record<string, unknown>);

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
  assert.match(card?.detail ?? '', /spends nothing/);
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

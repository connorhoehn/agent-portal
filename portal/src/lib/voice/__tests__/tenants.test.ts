// Each voice tenant's scripted session (MOCK_VOICE=1), end to end in the dock:
// the middleware's own MOCK_CALLS and mockLiveScript, the controller, the real
// runners, and fixtures standing in for that tenant's backend reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { FakeClock, fakeFetch, middlewareVoice, route, toolContext, type Route } from './voiceHarness.ts';
import { ResultMemory } from '../tools.ts';
import type { Action } from '../../capabilities';

type Call = { name: string; arguments: Record<string, unknown>; said: string };
const SESSION = 'vs_00000000-0000-0000-0000-0000000000bb';

interface MwCatalogue { MOCK_CALLS: Record<string, Call>; VOICE_TENANTS: readonly string[] }
interface MwOpenai { mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }

/** One tenant's scripted session run to the end; `extraStart` adds frames (a second call) to the script. */
export async function scriptedRun(tenant: string, opts: { role: string; allow: Action[]; routes: Route[]; extraStart?: unknown[]; ctx?: Parameters<typeof toolContext>[0]; call?: Call; beforeStop?: (c: VoiceController, ctx: ReturnType<typeof toolContext>) => Promise<void> | void }) {
  const { MOCK_CALLS } = await middlewareVoice<MwCatalogue>('catalogue.ts');
  const { mockLiveScript } = await middlewareVoice<MwOpenai>('openai.ts');
  const call = opts.call ?? MOCK_CALLS[tenant];
  assert.ok(call, `${tenant} has a scripted call`);
  const script = mockLiveScript(SESSION, call);
  const body = {
    sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
    model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    mockScript: { ...script, onStart: [...script.onStart, ...(opts.extraStart ?? [])] },
  };
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    ...opts.routes,
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, body),
  ]);
  const ctx = toolContext({ fetch, tenant, role: opts.role, allow: opts.allow, results: new ResultMemory(), ...(opts.ctx ?? {}) });
  const controller = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await controller.start();
  await clock.advance(opts.extraStart ? 8000 : 4000);
  await opts.beforeStop?.(controller, ctx);
  const stopping = controller.stop();
  await clock.advance(300);
  await stopping;
  const toolCalls = controller.getSnapshot().turns.flatMap((t) => t.toolCalls ?? []);
  const calls = toolCalls.map((c) => [c.name, c.status]);
  const summaries = toolCalls.map((c) => c.summary);
  const outcomes = log.filter((r) => r.url.endsWith('/events')).map((r) => (r.body as Record<string, unknown>)['outcome']);
  return { call, calls, summaries, outcomes, log, ctx };
}

test('the social scripted session searches the social index for huddles and gets rows', async () => {
  const huddle = { type: 'huddle', id: 'h-platform', title: 'Platform standup', kind: 'Huddle', subtitle: 'In the huddle now: Mira, Lena', status: 'live', href: '/social/calls', score: 4 };
  const run = await scriptedRun('social', {
    role: 'participant', allow: ['ViewSocial', 'PostMessage', 'StartCall', 'VoiceNavigate'],
    routes: [route('GET', '/api/social/search?', 200, { query: 'live huddles', results: [huddle], counts: { huddle: 1 }, total: 1 })],
  });
  assert.equal(run.call.name, 'search');
  assert.deepEqual(run.calls, [['search', 'done']]);
  assert.deepEqual(run.outcomes, ['done']);
  assert.deepEqual(run.summaries, ['1 of 1 for "live huddles"'], 'the row came back');
  const search = run.log.filter((r) => r.url.startsWith('/api/social/search'));
  assert.deepEqual(search.map((r) => r.url), ['/api/social/search?q=live+huddles&type=huddle&limit=5']);
});

test('the assessment, pipelines and access scripted sessions each run their read against that tenant\'s own route', async () => {
  const runs = [
    {
      tenant: 'assessment', role: 'assessor', allow: ['ViewAssessment', 'Search', 'VoiceNavigate'] as Action[],
      routes: [route('GET', '/api/assessment/search?', 200, { query: 'teams below target', results: [{ type: 'team', id: 't-atlas', title: 'Atlas', kind: 'Team', status: 'in progress', href: '/assessment/teams/t-atlas', score: 2 }], counts: {}, total: 1 })],
      url: '/api/assessment/search?q=teams+below+target&type=team&limit=5',
    },
    {
      tenant: 'pipelines', role: 'operator', allow: ['ViewPipelines', 'RunPipeline', 'VoiceNavigate'] as Action[],
      routes: [route('GET', '/api/pipelines/search?', 200, { query: 'failed runs', results: [{ type: 'run', id: 'run-9', title: 'Nightly ingest', kind: 'Run', status: 'failed', href: '/pipelines/runs/run-9', score: 2 }], counts: {}, total: 1 })],
      url: '/api/pipelines/search?q=failed+runs&type=run&limit=5',
    },
    {
      tenant: 'access', role: 'requester', allow: ['ViewAccess', 'RequestAccess', 'VoiceNavigate'] as Action[],
      routes: [route('GET', '/api/access/requests?', 200, { items: [{
        id: 'r1', kind: 'grant', reviewId: null, requester: { id: 'u1', displayName: 'Me' }, beneficiary: { id: 'u1', displayName: 'Me' },
        item: { id: 'orgiq:sme', title: 'SME in Work' }, justification: 'x', duration: 'standing', status: 'approved', submittedAt: '2026-11-07T10:00:00Z',
        steps: [{ step: 1, kind: 'manager', status: 'approved', decidedBy: { id: 'm', displayName: 'Maya Manager' }, decidedAt: '2026-11-07T11:00:00Z', eligible: [] }],
        sod: { verdict: 'clear', conflicts: [] },
      }] })],
      url: '/api/access/requests?scope=mine&q=SME',
    },
  ];
  for (const r of runs) {
    const run = await scriptedRun(r.tenant, { role: r.role, allow: r.allow, routes: r.routes });
    assert.deepEqual(run.calls, [[run.call.name, 'done']], r.tenant);
    assert.deepEqual(run.outcomes, ['done'], r.tenant);
    assert.ok(run.log.some((l) => l.url === r.url), `${r.tenant} read ${r.url}`);
    assert.doesNotMatch(run.summaries[0]!, /^Nothing|No request/, `${r.tenant} found its row`);
  }
});

/** A second delegation in the scripted session: the model calls `name` with `args` after the first answer. */
function secondCall(name: string, args: Record<string, unknown>, atMs = 4500): unknown[] {
  const d = 'item_mock_delegation_2', resp = 'resp_mock_3', fc = 'fc_mock_2', callId = 'call_mock_2';
  const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
  const a = JSON.stringify(args);
  return [
    { atMs, event: { type: 'session.input_transcript.delta', delta: 'Open the first one.', start_ms: 6000, end_ms: 6800 } },
    { atMs: atMs + 100, event: { type: 'session.delegation.created', offset_ms: 6900, delegation: { id: d, type: 'delegation', response_id: resp, target: 'responses' } } },
    { atMs: atMs + 110, event: env({ type: 'response.created', response: { id: resp, status: 'in_progress', output: [] } }) },
    { atMs: atMs + 300, event: env({ type: 'response.output_item.done', item: { id: fc, type: 'function_call', status: 'completed', arguments: a, call_id: callId, name }, output_index: 0, sequence_number: 4 }) },
    { atMs: atMs + 350, event: env({ type: 'response.completed', response: { id: resp, status: 'completed', output: [] } }) },
  ];
}

test('the orgiq scripted session finds the Kubernetes experts, then opens the first row\'s own href', async () => {
  const people = [
    { type: 'person', id: 'p-priya', title: 'Priya Natarajan', subtitle: 'Staff platform engineer', href: '/iq/search?tab=connections&selection=person%3Ap-priya' },
    { type: 'person', id: 'p-sam', title: 'Sam Ortiz', subtitle: 'SRE', href: '/iq/search?tab=connections&selection=person%3Ap-sam' },
  ];
  const run = await scriptedRun('orgiq', {
    role: 'member', allow: ['Search', 'VoiceNavigate'],
    routes: [route('GET', '/api/search?', 200, { results: people, total: 2 })],
    extraStart: secondCall('open', { ref: '1' }),
  });
  assert.deepEqual(run.calls, [['search', 'done'], ['open', 'done']]);
  assert.equal(run.ctx.navigations.at(-1), people[0]!.href, 'the person, on the connections tab the index links to');
  assert.equal(run.summaries[1], 'Opened Priya Natarajan');
});

test('a scripted open of a name where a ref is expected is refused and opens nothing', async () => {
  const run = await scriptedRun('orgiq', {
    role: 'member', allow: ['Search', 'VoiceNavigate'],
    routes: [route('GET', '/api/search?', 200, { results: [{ type: 'person', id: 'p1', title: 'Priya', href: '/iq/search?tab=connections&selection=person%3Ap1' }], total: 1 })],
    extraStart: secondCall('open', { ref: 'Priya Natarajan' }),
  });
  assert.deepEqual(run.calls, [['search', 'done'], ['open', 'refused']]);
  assert.equal(run.ctx.navigations.length, 1, 'only the search page');
});

test('an access approver\'s scripted session answers its approvals from the fixtures; a requester\'s reads its own requests', async () => {
  const ada = { id: 'r-ada', kind: 'grant', reviewId: null, requester: { id: 'u-ada', displayName: 'Ada Okafor' }, beneficiary: { id: 'u-ada', displayName: 'Ada Okafor' },
    item: { id: 'orgiq:sme', title: 'SME in Work' }, justification: 'x', duration: 'standing', status: 'pending', submittedAt: '2026-11-08T09:00:00Z',
    steps: [{ step: 1, kind: 'manager', status: 'current', eligible: [{ id: 'u-me', displayName: 'Me' }] }], sod: { verdict: 'clear', conflicts: [] } };
  const { mockCallFor } = await middlewareVoice<{ mockCallFor: (t: string, r: string) => Call }>('catalogue.ts');
  assert.equal(mockCallFor('access', 'approver').arguments['scope'], 'approvals');
  assert.deepEqual(mockCallFor('access', 'requester').arguments['filter'], { q: null, status: null, scope: 'mine', since: null });
  const run = await scriptedRun('access', {
    role: 'approver', allow: ['ViewAccess', 'RequestAccess', 'DecideAccess', 'VoiceNavigate'], call: mockCallFor('access', 'approver'),
    routes: [route('GET', '/api/access/approvals', 200, { items: [ada] })],
  });
  assert.deepEqual(run.calls, [['access_request_status', 'done']]);
  assert.equal(run.summaries[0], '1 waiting on you; first: SME in Work from Ada Okafor');
  assert.ok(run.log.some((l) => l.url === '/api/access/approvals'));
  // The same script for a requester (no DecideAccess) is refused with no read at all.
  const req = await scriptedRun('access', {
    role: 'requester', allow: ['ViewAccess', 'RequestAccess', 'VoiceNavigate'], call: mockCallFor('access', 'approver'),
    routes: [route('GET', '/api/access/approvals', 200, { items: [ada] })],
  });
  assert.deepEqual(req.calls, [['access_request_status', 'refused']]);
  assert.equal(req.log.filter((l) => l.method === 'GET').length, 0);
});

test('the social moderator\'s scripted session asks who is on a call: activity reads the live huddles (G6)', async () => {
  const { mockCallFor } = await middlewareVoice<{ mockCallFor: (t: string, r: string) => Call }>('catalogue.ts');
  const call = mockCallFor('social', 'moderator');
  assert.equal(call.name, 'activity');
  const huddle = { type: 'huddle', id: 'call-1', title: 'Live huddle in #platform', kind: 'Huddle', subtitle: 'In the huddle now: Mira, Lena', status: 'live', href: '/social/calls', score: 4 };
  const run = await scriptedRun('social', {
    role: 'moderator', allow: ['ViewSocial', 'PostMessage', 'StartCall', 'VoiceNavigate'], call,
    routes: [route('GET', '/api/social/search?', 200, { query: 'live huddles', results: [huddle], counts: { huddle: 1 }, total: 1 })],
  });
  assert.deepEqual(run.calls, [['activity', 'done']]);
  assert.deepEqual(run.outcomes, ['done']);
  assert.deepEqual(run.summaries, ['1 live huddle: Live huddle in #platform (In the huddle now: Mira, Lena)']);
  assert.deepEqual(run.log.filter((r) => r.url.startsWith('/api/social/search')).map((r) => r.url), ['/api/social/search?q=live+huddles&type=huddle&limit=50']);
});

test('an orgiq member\'s scripted session sets their status with no Social context, on the tenant lobby, and reads nothing (G10)', async () => {
  const writes: unknown[] = [];
  const run = await scriptedRun('orgiq', {
    role: 'member', allow: ['Search', 'VoiceNavigate'], routes: [],
    call: { name: 'set_status', arguments: { status: 'away', message: 'out today' }, said: 'Set my status to away: out today.' },
    ctx: { social: null, presence: { roster: () => [], lobby: () => ({ channel: 'orgiq:lobby', setStatus: (s) => { writes.push(s); }, updateMetadata: (m) => { writes.push(m); } }) } },
  });
  assert.deepEqual(run.calls, [['set_status', 'done']]);
  assert.deepEqual(writes, ['away', { statusMessage: 'out today' }]);
  assert.equal(run.log.filter((l) => l.method === 'GET').length, 0);
});

test('the V2-5 scripted sessions list access requests, pipeline runs, assessment teams and Social channels through list', async () => {
  const { mockCallFor } = await middlewareVoice<{ mockCallFor: (t: string, r: string) => Call }>('catalogue.ts');
  const runs = [
    { tenant: 'access', role: 'requester', allow: ['ViewAccess', 'RequestAccess', 'VoiceNavigate'] as Action[], prefix: '/api/access/requests',
      body: { items: [{ id: 'r1', item: { title: 'SME in Work' }, requester: { displayName: 'Me' }, beneficiary: { displayName: 'Me' }, status: 'submitted' }] },
      url: '/api/access/requests?scope=mine', summary: '1 access request; first: SME in Work' },
    { tenant: 'pipelines', role: 'author', allow: ['ViewPipelines', 'VoiceNavigate'] as Action[], prefix: '/api/pipelines/runs',
      body: { runs: [{ id: 'agent-run:9', definitionId: 'agent:nightly', status: 'failed' }] }, url: '/api/pipelines/runs?status=failed', summary: '1 run with status failed; first: agent:nightly' },
    { tenant: 'assessment', role: 'lead-assessor', allow: ['ViewAssessment', 'VoiceNavigate'] as Action[], prefix: '/api/assessment/teams',
      body: [{ id: 'TEAM-001', name: 'Northstar Payments' }, { id: 'TEAM-002', name: 'Kubernetes Operator' }], url: '/api/assessment/teams', summary: '2 teams; first: Northstar Payments' },
    { tenant: 'social', role: 'community-admin', allow: ['ViewSocial', 'VoiceNavigate'] as Action[], prefix: '/api/social/channels',
      body: { channels: [{ slug: 'general', name: 'General' }] }, url: '/api/social/channels', summary: '1 channel; first: General' },
  ];
  for (const r of runs) {
    const call = mockCallFor(r.tenant, r.role);
    assert.equal(call.name, 'list', r.tenant);
    const run = await scriptedRun(r.tenant, { role: r.role, allow: r.allow, call, routes: [route('GET', r.prefix, 200, r.body)] });
    assert.deepEqual(run.calls, [['list', 'done']], r.tenant);
    assert.deepEqual(run.outcomes, ['done'], r.tenant);
    assert.deepEqual(run.log.filter((l) => l.method === 'GET').map((l) => l.url), [r.url], r.tenant);
    assert.equal(run.summaries[0], r.summary, r.tenant);
  }
});

test('the V2-6 scripted sessions: an org leader asks about the sweeps, a pipeline admin what failed last night', async () => {
  const { mockCallFor } = await middlewareVoice<{ mockCallFor: (t: string, r: string) => Call }>('catalogue.ts');
  const runs = [
    { tenant: 'orgiq', role: 'org-leader', allow: ['Search', 'ManageBots', 'VoiceNavigate'] as Action[], routes: [
      route('GET', '/api/work/sweeps/runs', 200, { runs: [{ sweep: 'stale_docs', status: 'failed', startedAt: '2026-11-08T08:00:00Z', error: 'timeout', findings: null }] }),
      route('GET', '/api/work/findings', 200, { findings: [] }), route('GET', '/api/bots/runs', 200, { runs: [] }), route('GET', '/api/bots', 200, { bots: [{ id: 'b1', name: 'Docs bot' }] })],
      summary: /^1 failed sweep run$/ },
    { tenant: 'pipelines', role: 'pipeline-admin', allow: ['ViewPipelines', 'VoiceNavigate'] as Action[], routes: [
      route('GET', '/api/pipelines/runs', 200, { runs: [{ id: 'run-9', definitionId: 'runbook:nightly', status: 'failed', startedAt: '2026-11-08T02:00:00Z' }] }),
      route('GET', '/api/pipelines/queues', 200, { queues: [] })],
      summary: /^1 failed run since .*; latest: runbook:nightly$/ },
  ];
  for (const r of runs) {
    const call = mockCallFor(r.tenant, r.role);
    assert.equal(call.name, 'summary', r.role);
    const run = await scriptedRun(r.tenant, { role: r.role, allow: r.allow, call, routes: r.routes });
    assert.deepEqual(run.calls, [['summary', 'done']], r.role);
    assert.match(run.summaries[0]!, r.summary, r.role);
  }
});

test('the V2-7 scripted session: an HR admin asks what the org spent and hears the spend report\'s own figures', async () => {
  const { mockCallFor } = await middlewareVoice<{ mockCallFor: (t: string, r: string) => Call }>('catalogue.ts');
  const call = mockCallFor('orgiq', 'hr-admin');
  assert.equal(call.name, 'budget');
  const run = await scriptedRun('orgiq', {
    role: 'hr-admin', allow: ['ManageBudgets', 'VoiceNavigate'], call,
    routes: [route('GET', '/api/spend/report', 200, { totals: { knownUsd: 29.8063, projectedPeriodEndUsd: 112.49 }, groups: [{ key: 'p-auth', label: 'Auth Migration', knownUsd: 9.72 }] })],
  });
  assert.deepEqual(run.calls, [['budget', 'done']]);
  assert.equal(run.summaries[0], 'The org spent $29.81 this month; on pace for $112.49; most: Auth Migration at $9.72');
  assert.deepEqual(run.log.filter((l) => l.method === 'GET').map((l) => l.url), ['/api/spend/report?groupBy=initiative']);
});

test('V2-4: open with a name two initiatives share shows the choice card; "the second one" sets its ordinal, and choosing opens that row\'s own page', async () => {
  const projects = [{ id: 'p-alpha', name: 'Alpha migration' }, { id: 'p-alpha-2', name: 'Alpha rollout' }];
  const said = { atMs: 5000, event: { type: 'session.input_transcript.delta', delta: 'The second one.', start_ms: 7000, end_ms: 7600 } };
  let seen: unknown = null;
  const run = await scriptedRun('orgiq', {
    role: 'member', allow: ['Search', 'VoiceNavigate'],
    call: { name: 'open', arguments: { page: null, ref: null, kind: 'initiative', name: 'alpha', params: null }, said: 'Open Alpha.' },
    routes: [route('GET', '/api/graph/projects', 200, projects)],
    extraStart: [said],
    beforeStop: (c, ctx) => {
      const choice = c.getSnapshot().choice!;
      assert.equal(c.getSnapshot().phase, 'confirming', 'the card waits on the user (the library opens it in that phase)');
      seen = { titles: choice.candidates.map((x) => x.title), ordinal: choice.ordinal, hrefs: choice.candidates.map((x) => x.href) };
      assert.deepEqual(ctx.navigations, [], 'nothing opens while the user chooses');
      c.choose(choice.ordinal! - 1);
      assert.equal(c.getSnapshot().choice, null);
      assert.notEqual(c.getSnapshot().phase, 'confirming');
    },
  });
  assert.deepEqual(seen, { titles: ['Alpha migration', 'Alpha rollout'], ordinal: 2, hrefs: ['/iq/projects/p-alpha', '/iq/projects/p-alpha-2'] });
  assert.deepEqual(run.calls, [['open', 'refused']], 'ambiguous is a refusal the model turns into a question');
  assert.deepEqual(run.ctx.navigations, ['/iq/projects/p-alpha-2']);
});

test('V2-4: open by a unique name opens in one step, with no card', async () => {
  const run = await scriptedRun('orgiq', {
    role: 'member', allow: ['Search', 'VoiceNavigate'],
    call: { name: 'open', arguments: { page: null, ref: null, kind: 'initiative', name: 'Alpha', params: null }, said: 'Open Alpha.' },
    routes: [route('GET', '/api/graph/projects', 200, [{ id: 'p-alpha', name: 'Alpha' }, { id: 'p-alpha-2', name: 'Alpha rollout' }])],
    beforeStop: (c) => { assert.equal(c.getSnapshot().choice, null); },
  });
  assert.deepEqual(run.calls, [['open', 'done']]);
  assert.deepEqual(run.ctx.navigations, ['/iq/projects/p-alpha']);
});

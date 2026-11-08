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
export async function scriptedRun(tenant: string, opts: { role: string; allow: Action[]; routes: Route[]; extraStart?: unknown[]; ctx?: Parameters<typeof toolContext>[0]; call?: Call }) {
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
  assert.equal(run.call.name, 'search_records');
  assert.deepEqual(run.calls, [['search_records', 'done']]);
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
    extraStart: secondCall('open_result', { ref: '1' }),
  });
  assert.deepEqual(run.calls, [['search_people', 'done'], ['open_result', 'done']]);
  assert.equal(run.ctx.navigations.at(-1), people[0]!.href, 'the person, on the connections tab the index links to');
  assert.equal(run.summaries[1], 'Opened Priya Natarajan');
});

test('a scripted open_result for a ref no search returned is refused and opens nothing', async () => {
  const run = await scriptedRun('orgiq', {
    role: 'member', allow: ['Search', 'VoiceNavigate'],
    routes: [route('GET', '/api/search?', 200, { results: [{ type: 'person', id: 'p1', title: 'Priya', href: '/iq/search?tab=connections&selection=person%3Ap1' }], total: 1 })],
    extraStart: secondCall('open_result', { ref: 'person:not-a-row' }),
  });
  assert.deepEqual(run.calls, [['search_people', 'done'], ['open_result', 'refused']]);
  assert.equal(run.ctx.navigations.length, 1, 'only the search page');
});

test('an access approver\'s scripted session answers its approvals from the fixtures; a requester\'s reads its own requests', async () => {
  const ada = { id: 'r-ada', kind: 'grant', reviewId: null, requester: { id: 'u-ada', displayName: 'Ada Okafor' }, beneficiary: { id: 'u-ada', displayName: 'Ada Okafor' },
    item: { id: 'orgiq:sme', title: 'SME in Work' }, justification: 'x', duration: 'standing', status: 'pending', submittedAt: '2026-11-08T09:00:00Z',
    steps: [{ step: 1, kind: 'manager', status: 'current', eligible: [{ id: 'u-me', displayName: 'Me' }] }], sod: { verdict: 'clear', conflicts: [] } };
  const { mockCallFor } = await middlewareVoice<{ mockCallFor: (t: string, r: string) => Call }>('catalogue.ts');
  assert.equal(mockCallFor('access', 'approver').arguments['scope'], 'approvals');
  assert.equal(mockCallFor('access', 'requester').arguments['scope'], 'mine');
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

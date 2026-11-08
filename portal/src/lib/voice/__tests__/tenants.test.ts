// Each voice tenant's scripted session (MOCK_VOICE=1), end to end in the dock:
// the middleware's own MOCK_CALLS and mockLiveScript, the controller, the real
// runners, and fixtures standing in for that tenant's backend reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { FakeClock, fakeFetch, middlewareVoice, route, toolContext, type Route } from './voiceHarness.ts';
import type { Action } from '../../capabilities';

type Call = { name: string; arguments: Record<string, unknown>; said: string };
const SESSION = 'vs_00000000-0000-0000-0000-0000000000bb';

interface MwCatalogue { MOCK_CALLS: Record<string, Call>; VOICE_TENANTS: readonly string[] }
interface MwOpenai { mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }

/** One tenant's scripted session run to the end; `extraStart` adds frames (a second call) to the script. */
export async function scriptedRun(tenant: string, opts: { role: string; allow: Action[]; routes: Route[]; extraStart?: unknown[]; ctx?: Parameters<typeof toolContext>[0] }) {
  const { MOCK_CALLS } = await middlewareVoice<MwCatalogue>('catalogue.ts');
  const { mockLiveScript } = await middlewareVoice<MwOpenai>('openai.ts');
  const call = MOCK_CALLS[tenant];
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
  const ctx = toolContext({ fetch, tenant, role: opts.role, allow: opts.allow, ...(opts.ctx ?? {}) });
  const controller = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await controller.start();
  await clock.advance(4000);
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

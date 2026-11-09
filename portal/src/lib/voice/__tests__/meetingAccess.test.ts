// G25 (a meeting: the initiative's huddle room and a time, answered in the
// thread; there is no calendar, and the spoken line says so) and G27 (a
// refusal that names an access request offers it; one card files it through
// the Access tenant's quick route and the request id comes back).

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { InboundMemory, messageFromFrame } from '../inbound.ts';
import { NO_CALENDAR } from '../records.ts';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { ResultMemory, planPreparedCall, prepareToolCall, runPreparedCall, type SocialAccess } from '../tools.ts';
import { FakeClock, fakeFetch, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const PROJECTS = [{ id: 'p-auth', name: 'Auth Migration' }, { id: 'p-obs', name: 'Observability Platform' }];
const frame = { type: 'chat', action: 'message', channel: 'social:dm:u-me:u-theo', message: { id: 'm-9', userId: 'u-theo', message: 'Can we go over the auth cutover today?', metadata: { displayName: 'Theo Chang' }, timestamp: '2026-11-08T12:00:00Z' } };

function social(): SocialAccess & { sends: Array<Parameters<SocialAccess['send']>[0]> } {
  const sends: Array<Parameters<SocialAccess['send']>[0]> = [];
  return { api: '/api/social/plane', unavailable: null, presence: null, deliveries: new Map(), send: async (i) => { sends.push(i); }, sends };
}

async function confirmAndRun(name: string, args: unknown, ctx: ReturnType<typeof toolContext>) {
  const p = prepareToolCall(name, args, ctx);
  if (!p.ok) return { card: null, result: p.result };
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  if (planned && 'result' in planned) return { card: null, result: planned.result };
  return { card: planned!.plan, result: await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned!.plan.data) };
}

test('G25: a meeting from the thread: one card, the time and the room go back to the same thread, and the line says there is no calendar', async () => {
  const inbox = new InboundMemory();
  inbox.add(messageFromFrame(frame, 'u-me', 0)!);
  const s = social();
  const { fetch, log } = fakeFetch([route('GET', '/api/graph/projects', 200, PROJECTS)]);
  const ctx = toolContext({ fetch, social: s, inbox, results: new ResultMemory() });
  const { card, result } = await confirmAndRun('create', { kind: 'meeting', fields: { initiative: 'auth migration', time: '5 pm', thread: 'message:m-9' } }, ctx);
  assert.equal(card!.title, 'Meet at 5 pm in the Auth Migration huddle');
  assert.ok((card!.detail as string[]).includes(NO_CALENDAR));
  assert.equal(result.outcome, 'done');
  assert.equal(s.sends.length, 1);
  assert.equal(s.sends[0]!.channel, 'social:dm:u-me:u-theo', 'the reply goes back to the thread');
  assert.equal(s.sends[0]!.replyTo?.messageId, 'm-9');
  assert.match(s.sends[0]!.text, /5 pm in the Auth Migration huddle: \/iq\/projects\/p-auth/);
  assert.match(String(result.output['say']), /There is no calendar in the portal, so nothing is booked/);
  assert.equal(result.output['calendar'], false);
  assert.ok(!log.some((r) => r.method !== 'GET'), 'no calendar write: nothing but the initiative read');
  // Without a thread nobody is told, and nothing is posted.
  const s2 = social();
  const alone = await confirmAndRun('create', { kind: 'meeting', fields: { initiative: 'auth migration', time: '5 pm' } }, toolContext({ fetch, social: s2, inbox }));
  assert.equal(alone.result.outcome, 'done');
  assert.equal(s2.sends.length, 0);
});

test('G27: the refused message names the request and tells the model to offer it; one confirm files role:social:moderator and the id is spoken', async () => {
  const ctx0 = toolContext({ social: null, socialRequestItemId: 'role:social:moderator' });
  const p = prepareToolCall('message', { target: { kind: 'dm', name: 'Theo' }, text: 'hi' }, ctx0);
  const refusedRes = p.ok ? (await planPreparedCall(p.call, ctx0, VOICE_PLANNERS) as { result: { output: Record<string, unknown> } }).result : p.result;
  assert.equal(refusedRes.output['requestItemId'], 'role:social:moderator');
  assert.match(String(refusedRes.output['next']), /call create with kind "access-request" and fields \{ item: "role:social:moderator"/);
  assert.match(String(refusedRes.output['next']), /offer to try the original request again once the approval comes in/);

  // The scripted session: the model files it; one card; the quick route; the id comes back.
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: unknown) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const SESSION = 'vs_00000000-0000-0000-0000-0000000000a7';
  const call = { name: 'create', arguments: { kind: 'access-request', fields: { item: 'role:social:moderator', justification: 'I need to message the platform team' } }, said: 'Yes, file it: I need to message the platform team.' };
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['create'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, mockScript: mockLiveScript(SESSION, call) }),
    route('GET', '/api/access-requests/mine?itemId=role%3Asocial%3Amoderator', 200, { items: [] }),
    route('POST', '/api/access-requests/quick', 201, { id: 'req-0042', status: 'pending', item: { id: 'role:social:moderator' } }),
  ]);
  const ctx = toolContext({ fetch, social: null, socialRequestItemId: 'role:social:moderator' });
  const outputs: Array<Record<string, unknown>> = [];
  const { VoiceClient } = await import('../client.ts');
  const orig = VoiceClient.prototype.sendToolOutput;
  VoiceClient.prototype.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.call(this, id, o); };
  try {
    const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await c.start();
    await clock.advance(1200);
    assert.equal(c.getSnapshot().pending?.title, 'Request role:social:moderator for a week');
    assert.ok(!log.some((r) => r.url === '/api/access-requests/quick'), 'nothing filed before the confirm');
    c.confirm('click');
    await clock.advance(500);
    const filed = log.filter((r) => r.url === '/api/access-requests/quick');
    assert.equal(filed.length, 1, 'one request');
    assert.deepEqual(filed[0]!.body, { itemId: 'role:social:moderator', justification: 'Requested by voice in the orgiq workspace: I need to message the platform team', duration: '7d' });
    const out = outputs.at(-1)!;
    assert.equal(out['id'], 'req-0042');
    assert.match(String(out['say']), /request req-0042/);
    c.dispose();
  } finally { VoiceClient.prototype.sendToolOutput = orig; }
});

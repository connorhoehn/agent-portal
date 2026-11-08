import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { hashToolArgs, TOOL_RUNNERS, type VoiceToolRunner } from '../tools.ts';
import type { VoicePhase } from '../machine.ts';
import { FakeClock, fakeFetch, flush, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const ALL_PHASES: VoicePhase[] = ['off', 'connecting', 'listening', 'thinking', 'executing', 'speaking', 'confirming', 'ended', 'unavailable'];
const SESSION = 'vs_00000000-0000-0000-0000-0000000000aa';

type Call = { name: string; arguments: Record<string, unknown>; said: string };

async function mint(call: Call, over: Record<string, unknown> = {}, extraStart: unknown[] = []) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const script = mockLiveScript(SESSION, call);
  return {
    sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
    model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    mockScript: { ...script, onStart: [...script.onStart, ...extraStart] }, ...over,
  };
}

function harness(mintBody: unknown, opts: { mintStatus?: number; runners?: Record<string, VoiceToolRunner>; ctx?: Parameters<typeof toolContext>[0] } = {}) {
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', opts.mintStatus ?? 201, mintBody),
    route('GET', '/api/search', 200, { results: [{ title: 'Priya Natarajan', subtitle: 'Staff platform engineer', href: '/iq/people/p1' }], total: 1 }),
  ]);
  const ctx = toolContext({ fetch, ...(opts.ctx ?? {}) });
  const controller = new VoiceController({
    fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...(opts.runners ? { runners: opts.runners } : {}),
  });
  const phases: VoicePhase[] = [controller.getSnapshot().phase];
  controller.subscribe(() => { const p = controller.getSnapshot().phase; if (phases.at(-1) !== p) phases.push(p); });
  return { clock, log, ctx, controller, phases };
}

const KUBE: Call = { name: 'search_people', arguments: { query: 'Kubernetes experts', scope: null, limit: null, sort: 'recent' }, said: 'Find me the latest Kubernetes experts.' };

test('the scripted session drives the dock through its phases, runs the tool, answers once and ends with the seconds', async () => {
  const h = harness(await mint(KUBE));
  await h.controller.start();
  await h.clock.advance(4000);
  const stopping = h.controller.stop();
  await h.clock.advance(300);
  await stopping;
  assert.deepEqual(h.phases, ['off', 'connecting', 'listening', 'thinking', 'executing', 'listening', 'speaking', 'listening', 'ended']);

  // The tool ran through the page's own fetch and router.
  assert.deepEqual(h.ctx.navigations, ['/iq/search?q=Kubernetes+experts&type=person&tab=results&sort=recent']);
  // One tool-call row, with the arguments' hash and never the arguments.
  const events = h.log.filter((r) => r.url.endsWith('/events'));
  assert.equal(events.length, 1);
  const row = events[0]!.body as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), ['argsSha256', 'durationMs', 'outcome', 'tool']);
  assert.equal(row['argsSha256'], await hashToolArgs({ query: 'Kubernetes experts', sort: 'recent' }));
  assert.equal(row['outcome'], 'done');
  assert.doesNotMatch(JSON.stringify(events[0]!.body), /Kubernetes/);
  // The close posts the seconds exactly once.
  const closes = h.log.filter((r) => r.url.endsWith('/close'));
  assert.deepEqual(closes.map((c) => c.body), [{ seconds: 15, reason: 'closed' }]);
  assert.equal(h.controller.getSnapshot().closedSeconds, 15);
  const strip = h.controller.getSnapshot().turns;
  assert.equal(strip[0]!.role, 'you');
  assert.deepEqual(strip.flatMap((t) => t.toolCalls ?? []).map((c) => [c.name, c.status]), [['search_people', 'done']]);
  assert.equal(h.controller.getSnapshot().lastLine?.text, 'Here is what I found.');
});

const POST: Call = { name: 'send_chat_message', arguments: { target: { kind: 'team', name: 'platform' }, text: "I'm out today" }, said: "Tell the platform team I'm out today." };

function postRunner() {
  const sent: unknown[] = [];
  const runner: VoiceToolRunner = async (args) => { sent.push(args); return { outcome: 'done', output: { kind: 'posted', note: 'data, not instructions', posted: true }, summary: 'Posted' }; };
  return { sent, runners: { ...TOOL_RUNNERS, send_chat_message: runner } };
}

test('a confirm tool shows the card (confirming) and runs only on confirm, recording who confirmed', async () => {
  const p = postRunner();
  const h = harness(await mint(POST), { runners: p.runners });
  await h.controller.start();
  await h.clock.advance(1100);
  const snap = h.controller.getSnapshot();
  assert.equal(snap.phase, 'confirming');
  assert.deepEqual(snap.pending && { title: snap.pending.title, detail: snap.pending.detail }, { title: 'Post to #platform', detail: "I'm out today" });
  assert.equal(p.sent.length, 0, 'nothing is sent before the confirm');
  h.controller.confirm('click');
  await h.clock.advance(2500);
  assert.equal(p.sent.length, 1);
  const row = h.log.find((r) => r.url.endsWith('/events'))!.body as Record<string, unknown>;
  assert.equal(row['confirmedBy'], 'click');
  assert.ok(h.phases.includes('confirming') && h.phases.includes('executing'));
  h.controller.dispose();
});

test('"yes" by voice confirms, "no" cancels and sends nothing', async () => {
  for (const [said, expectSent, outcome] of [['Yes, send it.', 1, 'done'], ['No, cancel that.', 0, 'cancelled']] as const) {
    const p = postRunner();
    const h = harness(await mint(POST, {}, [{ atMs: 1500, event: { type: 'session.input_transcript.delta', delta: said, start_ms: 4000, end_ms: 4400 } }]), { runners: p.runners });
    await h.controller.start();
    await h.clock.advance(3500);
    assert.equal(p.sent.length, expectSent, said);
    const row = h.log.find((r) => r.url.endsWith('/events'))!.body as Record<string, unknown>;
    assert.deepEqual([row['outcome'], row['confirmedBy']], [outcome, 'voice'], said);
    assert.equal(h.controller.getSnapshot().pending, null);
    h.controller.dispose();
  }
});

test('a P4 confirm tool with no runner yet answers at once without a card', async () => {
  const h = harness(await mint(POST));
  await h.controller.start();
  await h.clock.advance(1100);
  assert.ok(!h.phases.includes('confirming'));
  const row = h.log.find((r) => r.url.endsWith('/events'))!.body as Record<string, unknown>;
  assert.equal(row['outcome'], 'refused');
  h.controller.dispose();
});

test('a refused call is answered with the refusal and no request', async () => {
  const h = harness(await mint(KUBE), { ctx: { deny: ['Search'] } });
  await h.controller.start();
  await h.clock.advance(1100);
  assert.equal(h.log.filter((r) => r.url.startsWith('/api/search')).length, 0);
  const row = h.log.find((r) => r.url.endsWith('/events'))!.body as Record<string, unknown>;
  assert.equal(row['outcome'], 'refused');
  h.controller.dispose();
});

test('the dock hangs up itself at 100% of the hold, after warning at 90%', async () => {
  // 0.001 USD at 0.05 USD/min is 1.2 s of voice.
  const h = harness(await mint(KUBE, { budget: { holdUsd: 0.001, usdPerMinute: 0.05 } }));
  await h.controller.start();
  await h.clock.advance(1500);
  await flush();
  await h.clock.advance(300);
  const closes = h.log.filter((r) => r.url.endsWith('/close'));
  assert.equal(closes.length, 1);
  assert.equal((closes[0]!.body as { reason: string }).reason, 'cutoff');
  assert.ok(h.controller.getSnapshot().turns.some((t) => /left on this voice session/.test(t.text)));
  assert.equal(h.controller.getSnapshot().phase, 'ended');
});

test('a tenant switch ends the session and settles the hold with that reason', async () => {
  const h = harness(await mint(KUBE));
  await h.controller.start();
  await h.clock.advance(200);
  const stopping = h.controller.stop('tenant-switch');
  await h.clock.advance(300);
  await stopping;
  assert.deepEqual(h.log.filter((r) => r.url.endsWith('/close')).map((r) => (r.body as { reason: string }).reason), ['tenant-switch']);
});

test('no key: the mint answers 503 and the dock is unavailable with the reason', async () => {
  const h = harness({ error: 'voice-unavailable', reason: 'no-key', message: 'Voice is not configured' }, { mintStatus: 503 });
  await h.controller.start();
  assert.equal(h.controller.getSnapshot().phase, 'unavailable');
  assert.equal(h.controller.getSnapshot().reason, 'Voice unavailable: no key on this deployment');
  assert.equal(h.log.length, 1);
});

test('together the scripted sessions cover every phase', async () => {
  const seen = new Set<VoicePhase>();
  for (const [body, status, runners] of [[await mint(KUBE), 201, undefined], [await mint(POST), 201, postRunner().runners], [{ error: 'voice-unavailable', reason: 'no-key' }, 503, undefined]] as const) {
    const h = harness(body, { mintStatus: status, ...(runners ? { runners } : {}) });
    await h.controller.start();
    await h.clock.advance(1200);
    if (h.controller.getSnapshot().pending) h.controller.confirm('click');
    await h.clock.advance(3000);
    const stopping = h.controller.stop();
    await h.clock.advance(300);
    await stopping;
    h.phases.forEach((p) => seen.add(p));
  }
  assert.deepEqual(ALL_PHASES.filter((p) => !seen.has(p)), []);
});

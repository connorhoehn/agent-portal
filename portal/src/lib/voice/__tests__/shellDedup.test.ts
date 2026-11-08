// G30 (docs/voice-navigator-gaps.md, the 23:03 session: four unconfirmed
// `computer` calls in five seconds): open-shell is one tab per box per
// session; a repeat focuses that tab and says so; the log keeps each call's action.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import type { ComputeAccess } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000ac';

/** Four delegations in five seconds, each one open-shell on the same box (no continuation asks again). */
function fourShells(computer: string) {
  const args = JSON.stringify({ action: 'open-shell', initiatives: null, computer, phrase: null, since: null, machine: null, job: null });
  const frames: Array<{ atMs: number; event: Record<string, unknown> }> = [
    { atMs: 0, event: { type: 'session.started', session: { id: 'live_mock', model: 'gpt-live-1', status: 'active' } } },
  ];
  for (let i = 1; i <= 4; i++) {
    const d = `item_d${i}`;
    const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
    const at = i * 1200;
    frames.push(
      { atMs: at, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: `r${i}`, target: 'responses' } } },
      { atMs: at + 100, event: env({ type: 'response.output_item.done', item: { id: `fc${i}`, type: 'function_call', status: 'completed', arguments: args, call_id: `call_${i}`, name: 'computer' } }) },
      { atMs: at + 150, event: env({ type: 'response.completed', response: { id: `r${i}`, status: 'completed', output: [] } }) },
    );
  }
  return { onStart: frames, onResponseCreate: [], onClose: [{ atMs: 100, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 8 } } }] };
}

test('G30 acceptance: four open-shell calls on one box in one session open one tab; the repeats focus it and say so', async () => {
  const outputs: Array<Record<string, unknown>> = [];
  const orig = VoiceClient.prototype.sendToolOutput;
  VoiceClient.prototype.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.call(this, id, o); };
  try {
    // The library's openShell: one tab per box id, a repeat focuses it (ui-components compute.d.ts).
    const tabs = new Map<string, number>();
    let focused = 0;
    const compute: ComputeAccess = {
      canManage: true,
      computers: () => [{ id: 'c1', label: 'alpha-1', sessionId: 'a'.repeat(40), status: 'running', projectId: 'p1', project: 'Alpha' }],
      create: async () => { throw new Error('no create'); },
      openShell: (box) => { if (tabs.has(box.id)) focused += 1; tabs.set(box.id, (tabs.get(box.id) ?? 0) + 1); return { ok: true, id: box.id }; },
      runCommand: async () => {},
      remove: async () => {},
    };
    const clock = new FakeClock();
    const mintBody = {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['computer'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: fourShells('alpha-1'),
    };
    const { fetch, log } = fakeFetch([
      route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
      route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
      route('POST', '/api/voice/sessions', 201, mintBody),
    ]);
    const ctx = toolContext({ fetch, compute });
    const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await c.start();
    await clock.advance(7000);

    assert.equal(tabs.size, 1, 'one tab');
    assert.equal(focused, 3, 'the three repeats focus it');
    assert.equal(c.getSnapshot().pending, null, 'open-shell never shows a card');
    assert.deepEqual(outputs.map((o) => [o['kind'], o['alreadyOpen'] ?? false]), [['shell_opened', false], ['shell_opened', true], ['shell_opened', true], ['shell_opened', true]]);
    const strip = c.getSnapshot().turns.flatMap((t) => t.toolCalls ?? []).map((t) => t.summary);
    assert.deepEqual(strip, ['Shell on alpha-1', ...Array(3).fill('Shell on alpha-1 was already open; focused it')]);
    // The log keeps each call's action (never the computer's name).
    const calls = loggedEvents(log).filter((e) => e['kind'] === 'tool-call');
    assert.equal(calls.length, 4);
    for (const e of calls) assert.equal((e['data'] as Record<string, unknown>)['action'], 'open-shell');
    assert.doesNotMatch(JSON.stringify(loggedEvents(log)), /alpha-1/);
    c.dispose();

    // A new session opens it afresh (the memory is per session, not per dock).
    outputs.length = 0;
    const c2 = new VoiceController({
      fetch: fakeFetch([
        route('POST', `/api/voice/sessions/${SESSION.replace('ac', 'ad')}/events`, 201, {}),
        route('POST', '/api/voice/sessions', 201, { ...mintBody, sessionId: SESSION.replace('ac', 'ad'), voiceSessionId: SESSION.replace('ac', 'ad') }),
      ]).fetch,
      media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    });
    await c2.start();
    await clock.advance(2000);
    assert.deepEqual(outputs.map((o) => o['alreadyOpen'] ?? false), [false]);
    c2.dispose();
  } finally {
    VoiceClient.prototype.sendToolOutput = orig;
  }
});

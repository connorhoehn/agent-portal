// G39 replay (session vs_8bb50a16): search people on the Search page, read
// who is online (nobody), then message one of the people the search showed.
// The message now reaches its card (confirm-shown) instead of `refused
// not-found`, and nothing is opened before the confirm.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { ResultMemory, type SocialAccess } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000f9';
type Call = { name: string; arguments: Record<string, unknown>; said: string };

test('G39 replay: search person, activity online, message dm ends at the card, not refused not-found', async () => {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const call: Call = { name: 'message', arguments: { target: { kind: 'dm', name: 'Priya Raman' }, text: 'Can you look at the release?' }, said: 'Message Priya that…' };
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['message'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, mockScript: mockLiveScript(SESSION, call),
    }),
    route('GET', '/api/social/plane/resolve', 404, { kind: 'person', match: null, candidates: [] }),
    route('GET', '/api/roster/users?personIds=p-002', 200, { users: [{ personId: 'p-002', userId: 'u-priya', displayName: 'Priya Raman', social: true }], unlinked: [] }),
  ]);
  // What the earlier search kept (five directory people, refs person:<id>), and an empty footer roster.
  const results = new ResultMemory();
  results.keep(['Priya Raman', 'Theo Chang', 'Vera Green', 'Nora DaSilva', 'Eli Garcia'].map((t, i) => ({ ref: `person:p-00${i + 2}`, title: t, href: `/iq/people/p-00${i + 2}` })));
  const social: SocialAccess = { api: '/api/social/plane', unavailable: null, presence: null, deliveries: new Map(), send: async () => {} };
  const ctx = toolContext({ fetch, social, results, presence: { roster: () => [], lobby: () => null } });
  const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await c.start();
  await clock.advance(2500);
  assert.equal(c.getSnapshot().pending?.title, 'Message Priya Raman');
  const events = loggedEvents(log);
  assert.ok(events.some((e) => e['kind'] === 'confirm-shown' && e['tool'] === 'message'));
  assert.ok(!events.some((e) => e['kind'] === 'refused'));
  assert.ok(!log.some((r) => r.method === 'POST' && r.url === '/api/social/dms'), 'the DM opens only at confirm');
  c.dispose();
});

// G63 (docs/voice-navigator-gaps.md, "Real sessions, 9 November 2026
// 13:47–14:01"): the session log explains a silent session without a word.
// The scripted session plays each outcome a user utterance can have (the voice
// delegated, answered in speech, the words resolved a card, or nothing came)
// and what each voice utterance followed; the context ratio, dropped frames,
// the microphone and the meter are rows too. Every row is numbers and enums,
// and the middleware's own schema (session-log.ts, loaded by path) takes them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import { CONTEXT_EVERY_MS, FRAMES_WINDOW_MS, HEARD_WAIT_MS, LEVEL_WINDOW_MS, SessionDiagnostics } from '../diagnostics.ts';
import { HEARD_OUTCOMES, LIVE_FRAME_TYPES, SPOKE_AFTER } from '../sessionEvents.ts';
import type { VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000d1';
/** The dock's clock is virtual; `atMs` is this epoch plus it. */
const EPOCH = Date.UTC(2026, 10, 9, 13, 56, 0);

type Frame = { atMs: number; event: Record<string, unknown> };
type Call = { id: string; name: string; args: Record<string, unknown> };

const env = (d: string, event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
const said = (atMs: number, text: string): Frame => ({ atMs, event: { type: 'session.input_transcript.delta', delta: text, start_ms: atMs, end_ms: atMs + 400 } });
const voice = (atMs: number, text: string): Frame => ({ atMs, event: { type: 'session.output_transcript.delta', delta: text, start_ms: atMs, end_ms: atMs + 600 } });
const delegate = (at: number, d: string, call?: Call): Frame[] => [
  { atMs: at, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: `r_${d}`, target: 'responses' } } },
  ...(call ? [{ atMs: at + 20, event: env(d, { type: 'response.output_item.done', item: { id: `fc_${call.id}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(call.args), call_id: call.id, name: call.name } }) }] : []),
  { atMs: at + 30, event: env(d, { type: 'response.completed', response: { id: `r_${d}`, status: 'completed', output: [] } }) },
];
const usage = (atMs: number, seconds: number, ratio: number): Frame => ({ atMs, event: { type: 'session.usage.updated', usage: { seconds }, context_window: { usage_ratio: ratio } } });

/** Words the user and the voice say in the script: none of them may reach a logged row (the tab `docs` is an enum argument, logged as the call's shape). */
const WORDS = ['Open the', 'whiteboard called', 'Retro', 'think of it', 'looks fine', 'Confirm.', 'Are you there', 'Done.', 'By the way'];

async function scripted(onStart: Frame[]) {
  const clock = new FakeClock();
  const mint = {
    sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-09T14:30:00Z', sdp: 'v=0', mock: true,
    model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['open', 'create'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    mockScript: {
      onStart: [{ atMs: 0, event: { type: 'session.started', session: { id: 'live_d1' } } }, ...onStart],
      onResponseCreate: [{ atMs: 100, event: env('$continued', { type: 'response.completed', response: { id: 'r_c', status: 'completed', output: [] } }) }, voice(300, 'Done.')],
      onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 31 } } }],
    },
  };
  const { fetch, log } = fakeFetch([route('POST', '/api/voice/sessions/vs_', 201, {}), route('POST', '/api/voice/sessions', 201, mint)]);
  const ran: string[] = [];
  const stub: VoiceToolRunner = async () => { ran.push('create'); return { outcome: 'done', output: { kind: 'created' }, summary: 'Done' }; };
  const page = { path: '/iq/projects/p1', record: { ref: 'initiative:p1', title: 'Alpha' }, rowsLabel: 'work items', rows: [] };
  const ctx = toolContext({ fetch, role: 'org-leader', page: () => page, tabs: () => ({ path: page.path, tabs: ['overview', 'docs'], tab: 'overview' }) });
  const c = new VoiceController({
    fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, create: stub }, planners: {}, epoch: (at) => EPOCH + at,
  });
  const diag = (name: string) => loggedEvents(log).filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === name).map((e) => e['data'] as Record<string, unknown>);
  return { c, clock, log, ran, diag };
}

test('G63: each utterance is a heard row with its outcome (delegated, answered, card, ignored) and each voice utterance a spoke row with what it followed; no words', async () => {
  const h = await scripted([
    said(300, 'Open the docs tab.'), ...delegate(600, 'd1', { id: 'c1', name: 'open', args: { scope: 'this-page', tab: 'docs' } }),
    usage(1200, 1, 0.0098),
    { atMs: 2000, event: { type: 'info', message: 'something the dock never reads' } },
    { atMs: 2100, event: { type: 'brand.new.event' } },
    said(5000, 'What do you think of it?'), voice(5600, 'It looks fine to me.'),
    said(9000, 'Create a whiteboard called Retro.'), ...delegate(9300, 'd2', { id: 'c2', name: 'create', args: { kind: 'whiteboard', fields: { title: 'Retro' } } }),
    // The confirm word, and the empty delegation the front model makes on it (vs_89fba6d6 13:54:21).
    said(11000, 'Confirm.'), ...delegate(11100, 'd3'),
    voice(14500, 'By the way, one more thing.'),
    said(16000, 'Are you there?'),
    usage(20000, 20, 0.0153),
    { atMs: 26000, event: { type: 'session.input_audio.unmuted' } },
  ]);
  await h.c.start();
  await h.clock.advance(25_000);
  h.c.toggleMute();
  await h.clock.advance(5_000);
  // The stop waits on the scripted session.closed, which plays on the virtual clock.
  const stopping = h.c.stop();
  await h.clock.advance(2_000);
  await stopping;

  assert.deepEqual(h.ran, ['create'], 'the card was confirmed by voice');
  const heard = h.diag('heard');
  assert.deepEqual(heard.map((r) => [r['n'], r['outcome'], r['wordCount'], r['delegations']]), [
    [1, 'delegated', 4, 1], [2, 'answered', 6, 0], [3, 'delegated', 5, 1], [4, 'card', 1, 1], [5, 'ignored', 3, 0],
  ]);
  assert.deepEqual(heard.map((r) => r['ms']), [400, 400, 400, 400, 400], 'the audio span from the transcript timeline');
  assert.equal(heard[0]!['atMs'], EPOCH + 300);
  assert.equal(heard[4]!['afterMs'], null, 'nothing came');
  assert.equal(typeof heard[0]!['afterMs'], 'number');
  const spoke = h.diag('spoke');
  assert.deepEqual(spoke.map((r) => [r['after'], r['wordCount']]), [['result', 1], ['user', 5], ['result', 1], ['unprompted', 6]]);
  assert.deepEqual(h.diag('context').map((r) => r['ratio']), [0.0098, 0.0153], 'at most every 30 s, the last one at the end');
  assert.deepEqual(h.diag('frames'), [{ event: 'frames', windowS: 28, counts: { info: 1, unknown: 1 } }]);
  assert.deepEqual(h.diag('mic'), [{ event: 'mic', muted: true, by: 'user' }, { event: 'mic', muted: false, by: 'provider' }]);
  const level = h.diag('level');
  assert.equal(level.length, 1);
  assert.deepEqual({ ...level[0], samples: undefined, windowS: undefined }, { event: 'level', samples: undefined, windowS: undefined, min: 0, avg: 0, max: 0, mutedPct: 3 }, 'muted from the toggle at 25 s to the provider unmute at 26 s');
  assert.ok((level[0]!['samples'] as number) > 250);

  // Numbers and enums only, and the middleware's schema takes every one of them.
  const { checkDiagnostic } = await diagSchema();
  const rows = ['heard', 'spoke', 'context', 'frames', 'mic', 'level'].flatMap((n) => h.diag(n));
  for (const r of rows) {
    assert.equal(checkDiagnostic(r), null, JSON.stringify(r));
    for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && k !== 'event') assert.ok([...HEARD_OUTCOMES, ...SPOKE_AFTER, 'user', 'provider'].includes(v), `${k}: ${v}`);
  }
  const text = JSON.stringify(loggedEvents(h.log));
  for (const w of WORDS) assert.ok(!text.includes(w), `"${w}" reached the log: ${text.slice(Math.max(0, text.indexOf(w) - 120), text.indexOf(w) + 40)}`);
  h.c.dispose();
});

test('G63: an utterance the voice delegated and then spoke about stays `delegated`, and the line is `after a result`', async () => {
  const h = await scripted([
    said(300, 'Open the first one.'), ...delegate(600, 'd1', { id: 'c1', name: 'open', args: { scope: 'this-page', tab: 'docs' } }),
  ]);
  await h.c.start();
  await h.clock.advance(3_000);
  const stopping = h.c.stop();
  await h.clock.advance(1_000);
  await stopping;
  assert.deepEqual(h.diag('heard').map((r) => r['outcome']), ['delegated']);
  assert.deepEqual(h.diag('spoke').map((r) => r['after']), ['result']);
  h.c.dispose();
});

/** The middleware's checker, compiled from its source (session-log.ts imports providers, so only the schema half is lifted). */
async function diagSchema(): Promise<{ checkDiagnostic(d: Record<string, unknown>): string | null; LIVE_FRAME_TYPES: readonly string[] }> {
  const { readFile } = await import('node:fs/promises');
  const { transform } = await import('esbuild');
  const dir = new URL('../../../../../middleware/src/lib/voice/', import.meta.url);
  const log = await readFile(new URL('session-log.ts', dir), 'utf8');
  const from = log.indexOf('/** How a finished user utterance ended. */');
  const to = log.indexOf('// ─── The dock\'s events');
  const { LIVE_FRAME_TYPES: types } = await middlewareVoice<{ LIVE_FRAME_TYPES: readonly string[] }>('openai.ts');
  const source = `const LIVE_FRAME_TYPES = ${JSON.stringify(types)}; const frameKey = (t) => t.replace(/\\./g, '_');
    const FRAME_KEYS = new Set([...LIVE_FRAME_TYPES.map(frameKey), 'unknown']);\n${log.slice(from, to)}\nexport { LIVE_FRAME_TYPES };`;
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) as never;
}

test('G63: the portal and the middleware name the same frame types', async () => {
  const { LIVE_FRAME_TYPES: theirs } = await diagSchema();
  assert.deepEqual([...LIVE_FRAME_TYPES], [...theirs]);
});

// ── the row budget (the log's 500-row cap) ──

test('G63: a 30-minute session spends at most 150 rows on the periodic diagnostics, however chatty its frames', () => {
  const clock = new FakeClock();
  const rows: Array<Record<string, unknown>> = [];
  const d = new SessionDiagnostics({ emit: (r) => rows.push(r), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, epoch: (t) => t });
  const fire = () => { for (;;) { const due = (clock as unknown as { timers: Map<number, { at: number; fn: () => void }> }).timers; const next = [...due.entries()].find(([, v]) => v.at <= clock.t); if (!next) break; due.delete(next[0]); next[1].fn(); } };
  for (let t = 0; t <= 30 * 60_000; t += 100) {
    clock.t = t;
    fire();
    d.levelSample(t % 2000 < 500 ? 0.3 : 0.01, false);
    if (t % 15_000 === 0) d.contextRatio(0.01 + t / 3_600_000, t / 1000);
    if (t % 1000 === 0) { d.droppedFrame('info'); d.droppedFrame('rate_limits.updated'); }
  }
  d.flush();
  const count = (n: string) => rows.filter((r) => r['event'] === n).length;
  assert.ok(count('level') <= 30 * 60_000 / LEVEL_WINDOW_MS + 1, `level ${count('level')}`);
  assert.ok(count('context') <= 30 * 60_000 / CONTEXT_EVERY_MS + 1, `context ${count('context')}`);
  assert.ok(count('frames') <= 30 * 60_000 / FRAMES_WINDOW_MS + 1, `frames ${count('frames')}`);
  assert.ok(rows.length <= 150 + 3, `${rows.length} rows`);
  const f = rows.find((r) => r['event'] === 'frames')!;
  assert.deepEqual(f['counts'], { info: 60, rate_limits_updated: 60 });
  const l = rows.find((r) => r['event'] === 'level')!;
  assert.equal(l['max'], 0.3);
  assert.equal(l['min'], 0.01);
});

test('G63: a heard utterance ends HEARD_WAIT_MS after its last word, or when the next one begins', async () => {
  const clock = new FakeClock();
  const rows: Array<Record<string, unknown>> = [];
  const d = new SessionDiagnostics({ emit: (r) => rows.push(r), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, epoch: (t) => t });
  d.userWords(' Find', 0, 200);
  clock.t = 200; d.userWords(' me the', 200, 600);
  clock.t = 3000; d.userWords(' Hello?', 3000, 3400);
  assert.deepEqual(rows.map((r) => [r['outcome'], r['wordCount'], r['ms']]), [['ignored', 3, 600]], 'the next utterance ended the first');
  await clock.advance(HEARD_WAIT_MS);
  assert.deepEqual(rows.map((r) => r['outcome']), ['ignored', 'ignored']);
});

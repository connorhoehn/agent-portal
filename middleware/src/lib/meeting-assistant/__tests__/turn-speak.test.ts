// Speak: the line is logged before any audio, TTS gets exactly the logged words, playout is paced and stoppable, and every
// failure leaves the log telling the truth (REBUILD-PLAN.md phase 0 tests, REBUILD-REVIEW.md risks 3 and 10).
jest.mock('../trace.js', () => ({ trace: () => undefined }));
import { Mouth, speakLine, PLAYOUT_LEAD_MS, type SpeakDeps } from '../turn/speak.js';
import { VOICE_FRAME_BYTES, VOICE_FRAME_MS } from '../voice.js';
import type { PolicyCall } from '../policy.js';
import type { SpokenLine, SpokenOutcome, TurnPolicy } from '../turn/types.js';
import type { streamSpeech } from '../../voice/openai-tts.js';

const CALL = { tenant: 't', callId: 'c' } as unknown as PolicyCall;
const LINE: SpokenLine = { text: 'Design a rate limiter for a public API.', askedBy: 'lead', tool: 'ask', sentenceId: 's1' };
const msOfAudio = (ms: number): Buffer => Buffer.alloc((ms / VOICE_FRAME_MS) * VOICE_FRAME_BYTES, 1);

/** A fake clock: sleep advances it; the TTS hands over its audio in 1 s chunks, one per tick. */
function rig(opts: { audioMs?: number; ttsFails?: 'before' | 'after-1s'; hold?: boolean; logThrows?: boolean } = {}) {
  let t = 0;
  const events: string[] = [];
  const pushes: Array<{ at: number; bytes: number; last: boolean }> = [];
  const marks: SpokenOutcome[] = [];
  const policy: Pick<TurnPolicy, 'logSpoken' | 'markSpoken' | 'holdSpeech'> = {
    logSpoken: async (_c, l) => { if (opts.logThrows) throw new Error('db'); events.push(`log:${l.text}`); return 'row1'; },
    markSpoken: async (_c, _r, _l, o) => { marks.push(o); },
    holdSpeech: async () => (opts.hold === false ? null : { release: async () => { events.push('release'); } }),
  };
  const tts = (async (text, o) => {
    events.push(`tts:${text}`);
    if (opts.ttsFails === 'before') throw new Error('500');
    const total = opts.audioMs ?? 1000;
    for (let sent = 0; sent < total; sent += 1000) {
      if (o.signal?.aborted) throw new Error('aborted');
      if (opts.ttsFails === 'after-1s' && sent >= 1000) throw new Error('broke');
      o.onAudio(msOfAudio(Math.min(1000, total - sent)));
      await Promise.resolve();
    }
    return { firstAudioMs: 500, ms: 600, bytes: 0 };
  }) as typeof streamSpeech;
  const deps: SpeakDeps = {
    push: (pcm, last) => { if (!pushes.length) events.push('audio'); pushes.push({ at: t, bytes: pcm.length, last }); },
    clear: () => { events.push('clear'); },
    post: async (l) => { events.push(`post:${l.text}`); },
    tts, now: () => t, sleep: async (ms) => { t += ms; await Promise.resolve(); },
  };
  return { deps, policy, events, pushes, marks, time: () => t };
}

it('logs, posts, then says exactly the logged words', async () => {
  const r = rig();
  const res = await speakLine({ call: CALL, policy: r.policy, line: LINE }, r.deps).done;
  expect(r.events.slice(0, 4)).toEqual([`log:${LINE.text}`, `post:${LINE.text}`, `tts:${LINE.text}`, 'audio']);
  expect(res).toMatchObject({ outcome: 'spoken', rowId: 'row1' });
  expect(r.marks).toEqual(['spoken']);
  expect(r.events).toContain('release');
});

it('a 12 s line is heard whole, paced at most 300 ms ahead, its last frame marked', async () => {
  const r = rig({ audioMs: 12_000 });
  const res = await speakLine({ call: CALL, policy: r.policy, line: LINE }, r.deps).done;
  expect(r.pushes).toHaveLength(120);
  expect(r.pushes.reduce((a, p) => a + p.bytes, 0)).toBe(msOfAudio(12_000).length);
  expect(r.pushes.filter((p) => p.last)).toHaveLength(1);
  expect(r.pushes.at(-1)!.last).toBe(true);
  r.pushes.forEach((p, i) => expect(i * VOICE_FRAME_MS - p.at).toBeLessThanOrEqual(PLAYOUT_LEAD_MS));
  expect(res.playEndMs! - res.playStartMs!).toBe(12_000);
});

it('talked over: stops, clears the relay, the row is partly', async () => {
  const r = rig({ audioMs: 12_000 });
  const origSleep = r.deps.sleep!;
  let s: ReturnType<typeof speakLine> | null = null;
  r.deps.sleep = async (ms) => { await origSleep(ms); if (r.time() >= 2000) s?.stop(); };
  s = speakLine({ call: CALL, policy: r.policy, line: LINE }, r.deps);
  const res = await s.done;
  expect(res).toMatchObject({ outcome: 'partly', why: 'stopped' });
  expect(r.events).toContain('clear');
  expect(r.pushes.length).toBeLessThan(30);
  expect(r.marks).toEqual(['partly']);
});

it('a refused hold (cap reached): posted, nothing played, unspoken', async () => {
  const r = rig({ hold: false });
  const res = await speakLine({ call: CALL, policy: r.policy, line: LINE }, r.deps).done;
  expect(res).toMatchObject({ outcome: 'unspoken', why: 'no-hold' });
  expect(r.events).toEqual([`log:${LINE.text}`, `post:${LINE.text}`]);
  expect(r.pushes).toHaveLength(0);
});

it('a TTS error leaves the line posted, unspoken; a break mid-line is partly', async () => {
  const a = rig({ ttsFails: 'before' });
  expect((await speakLine({ call: CALL, policy: a.policy, line: LINE }, a.deps).done)).toMatchObject({ outcome: 'unspoken', why: 'tts-failed' });
  expect(a.events).toContain(`post:${LINE.text}`);
  const b = rig({ ttsFails: 'after-1s', audioMs: 5000 });
  expect((await speakLine({ call: CALL, policy: b.policy, line: LINE }, b.deps).done)).toMatchObject({ outcome: 'partly', why: 'tts-failed' });
});

it('a log that throws: neither posted nor said', async () => {
  const r = rig({ logThrows: true });
  const res = await speakLine({ call: CALL, policy: r.policy, line: LINE }, r.deps).done;
  expect(res.outcome).toBe('not-logged');
  expect(r.events).toEqual(['release']);
  expect(r.pushes).toHaveLength(0);
});

it('a line a server tool already logged is not logged again', async () => {
  const r = rig();
  const res = await speakLine({ call: CALL, policy: r.policy, line: LINE, logged: { rowId: null } }, r.deps).done;
  expect(r.events.some((e) => e.startsWith('log:'))).toBe(false);
  expect(res.outcome).toBe('spoken');
});

it('the mouth says lines one at a time, and stopAll drops the queue', async () => {
  const r = rig({ audioMs: 2000 });
  const mouth = new Mouth(r.deps);
  const one = mouth.say({ call: CALL, policy: r.policy, line: LINE });
  const two = mouth.say({ call: CALL, policy: r.policy, line: { ...LINE, text: 'Second.', sentenceId: 's2' } });
  expect((await one).outcome).toBe('spoken');
  expect((await two).outcome).toBe('spoken');
  expect(r.events.indexOf('tts:Second.')).toBeGreaterThan(r.events.indexOf(`tts:${LINE.text}`));
  const three = mouth.say({ call: CALL, policy: r.policy, line: { ...LINE, text: 'Third.' } });
  const four = mouth.say({ call: CALL, policy: r.policy, line: { ...LINE, text: 'Fourth.' } });
  mouth.stopAll();
  expect((await three).outcome).not.toBe('spoken');
  expect((await four).outcome).toBe('unspoken');
  expect(r.events).not.toContain('tts:Fourth.');
});

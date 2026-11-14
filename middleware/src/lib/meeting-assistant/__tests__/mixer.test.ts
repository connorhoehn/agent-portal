import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallMixer, FRAME_MS, IN_RATE, LinearResampler, OUT_RATE, int16ToPcm, pcmToInt16 } from '../mixer.js';
import { VoicedTimeline } from '../attribution.js';

const sine = (freq: number, ms: number, rate: number, amp = 8000, phase = 0): Int16Array => {
  const n = Math.round((ms / 1000) * rate);
  return Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin(2 * Math.PI * freq * ((i + phase) / rate))));
};
const crossings = (s: Int16Array): number => { let c = 0; for (let i = 1; i < s.length; i += 1) if ((s[i - 1]! < 0) !== (s[i]! < 0)) c += 1; return c; };
const maxStep = (s: Int16Array): number => { let m = 0; for (let i = 1; i < s.length; i += 1) m = Math.max(m, Math.abs(s[i]! - s[i - 1]!)); return m; };

describe('LinearResampler', () => {
  it('keeps the frequency: a 440 Hz sine out at 24 kHz still crosses zero 880 times a second', () => {
    const out = new LinearResampler().process(sine(440, 1000, IN_RATE));
    expect(Math.abs(out.length - OUT_RATE)).toBeLessThanOrEqual(2);
    expect(Math.abs(crossings(out) - 880)).toBeLessThanOrEqual(2);
  });

  it('leaves no trace of chunk boundaries: 200 ms chunks resample to what the whole stream does', () => {
    const whole = sine(440, 1000, IN_RATE);
    const a = new LinearResampler().process(whole);
    const r = new LinearResampler();
    const parts: Int16Array[] = [];
    for (let at = 0; at < whole.length; at += 3200) parts.push(r.process(whole.subarray(at, at + 3200)));
    const joined = Int16Array.from(parts.flatMap((p) => [...p]));
    expect(joined.length).toBe(a.length);
    expect(joined).toEqual(a);
    // And no click: the biggest sample-to-sample step of a 440 Hz sine of this size is small everywhere, boundaries included.
    expect(maxStep(joined)).toBeLessThan(8000 * 2 * Math.PI * 440 / OUT_RATE * 1.1);
  });

  it('odd chunk sizes work too (the carried position is fractional)', () => {
    const whole = sine(300, 500, IN_RATE);
    const a = new LinearResampler().process(whole);
    const r = new LinearResampler();
    const parts: number[] = [];
    let at = 0; const sizes = [7, 101, 1, 3333, 5];
    for (let i = 0; at < whole.length; i += 1) { parts.push(...r.process(whole.subarray(at, at + sizes[i % sizes.length]!))); at += sizes[i % sizes.length]!; }
    expect(parts.length).toBe(a.length);
    expect(Int16Array.from(parts)).toEqual(a);
  });
});

function harness(opts: { frames?: Buffer[]; placed?: Array<{ userId: string; atMs: number; samples: number }> } = {}) {
  const wall = { now: 1_000_000 };
  const frames = opts.frames ?? [];
  const placed = opts.placed ?? [];
  const mixer = new CallMixer({
    clock: () => wall.now, onFrame: (f) => frames.push(f),
    onPlaced: (userId, pcm, atMs) => placed.push({ userId, atMs, samples: pcm.length / 2 }),
  });
  const advance = (ms: number) => { wall.now += ms; return mixer.tick(); };
  return { wall, mixer, frames, placed, advance };
}
const chunk = (s: Int16Array) => int16ToPcm(s);

describe('CallMixer output', () => {
  it('emits one 100 ms 24 kHz frame per 100 ms of wall time, silence when nobody speaks', () => {
    const h = harness();
    expect(h.advance(50)).toBe(0);
    expect(h.advance(50)).toBe(1);
    expect(h.advance(1000)).toBe(10);
    expect(h.frames).toHaveLength(11);
    for (const f of h.frames) { expect(f.length).toBe((OUT_RATE * FRAME_MS) / 1000 * 2); expect(f.every((b) => b === 0)).toBe(true); }
  });

  it('catches up after a stall by emitting every missed frame, so the provider timeline never skips', () => {
    const h = harness();
    expect(h.advance(2500)).toBe(25);
    expect(h.mixer.cursorMs).toBe(2500);
  });

  it('a speaker\'s chunks come out as continuous audio of the right pitch', () => {
    const h = harness();
    const tone = sine(440, 2000, IN_RATE);
    for (let at = 0; at < tone.length; at += 3200) { h.mixer.push('u1', chunk(tone.subarray(at, at + 3200))); h.advance(200); }
    h.advance(1000);
    const out = Int16Array.from(h.frames.flatMap((f) => [...pcmToInt16(f)]));
    const voiced = out;
    // Find the voiced span and count crossings in the middle second of it.
    const first = voiced.findIndex((v) => Math.abs(v) > 100); const last = voiced.length - 1 - [...voiced].reverse().findIndex((v) => Math.abs(v) > 100);
    expect(first).toBeGreaterThanOrEqual(0);
    const span = voiced.subarray(first + 100, last - 100);
    const seconds = span.length / OUT_RATE;
    expect(Math.abs(crossings(span) / seconds - 880)).toBeLessThan(15);
    // Continuous: no step bigger than a 440 Hz sine of this amplitude can make anywhere in the span (a boundary click would be).
    expect(maxStep(span)).toBeLessThan(8000 * 2 * Math.PI * 440 / OUT_RATE * 1.1);
  });

  it('sums two speakers and clamps instead of wrapping', () => {
    const h = harness();
    const loud = new Int16Array(3200).fill(30000);
    h.mixer.push('a', chunk(loud)); h.mixer.push('b', chunk(loud));
    h.advance(1000);
    const out = Int16Array.from(h.frames.flatMap((f) => [...pcmToInt16(f)]));
    expect(Math.max(...out)).toBe(32767);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0); // never wrapped negative
    const quiet = harness();
    quiet.mixer.push('a', chunk(new Int16Array(3200).fill(1000))); quiet.mixer.push('b', chunk(new Int16Array(3200).fill(2000)));
    quiet.advance(1000);
    const q = Int16Array.from(quiet.frames.flatMap((f) => [...pcmToInt16(f)]));
    expect(Math.max(...q)).toBe(3000);
  });

  it('is jitter tolerant: chunks that arrive in a bunch still play in order, back to back', () => {
    const h = harness();
    const tone = sine(440, 1000, IN_RATE);
    // Five 200 ms chunks delivered together after a stall.
    h.advance(100);
    for (let at = 0; at < tone.length; at += 3200) h.mixer.push('u1', chunk(tone.subarray(at, at + 3200)));
    h.advance(2000);
    const out = Int16Array.from(h.frames.flatMap((f) => [...pcmToInt16(f)]));
    const idx = out.findIndex((v) => Math.abs(v) > 100);
    const end = out.length - 1 - [...out].reverse().findIndex((v) => Math.abs(v) > 100);
    expect((end - idx) / OUT_RATE).toBeGreaterThan(0.95);
    expect((end - idx) / OUT_RATE).toBeLessThan(1.05);
    expect(h.mixer.stats.lateChunks).toBe(0);
  });

  it('drops a chunk that is more than 400 ms behind and counts it; a smaller lag is trimmed, not dropped', () => {
    const h = harness();
    h.advance(3000); // the output is at 3000 ms
    expect(h.mixer.push('a', chunk(sine(300, 200, IN_RATE)), 1000)).toBe('late'); // arrived "1 s ago": slot is ~2 s behind
    expect(h.mixer.stats.lateChunks).toBe(1);
    // A slot ~250 ms in the past: kept from the cursor on.
    const at = h.mixer.cursorMs + 200 - 300 + 250 - 100; // arrival whose slot starts 250 ms behind the cursor
    expect(h.mixer.push('b', chunk(sine(300, 200, IN_RATE)), at - 0)).toBe('placed');
    expect(h.mixer.stats.lateChunks).toBe(1);
  });

  it('bounds memory: audio too far ahead of the output is dropped and counted', () => {
    const h = harness();
    let overrun = 0;
    // 40 seconds of audio delivered at once.
    for (let i = 0; i < 200; i += 1) if (h.mixer.push('a', chunk(sine(200, 200, IN_RATE))) === 'overrun') overrun += 1;
    expect(overrun).toBeGreaterThan(100);
    expect(h.mixer.stats.overrunChunks).toBe(overrun);
  });

  it('refuses a seventeenth participant, and nothing after close', () => {
    const h = harness();
    for (let i = 0; i < 16; i += 1) expect(h.mixer.push(`u${i}`, chunk(sine(200, 200, IN_RATE)))).toBe('placed');
    expect(h.mixer.push('u16', chunk(sine(200, 200, IN_RATE)))).toBe('rejected');
    h.mixer.close();
    expect(h.mixer.push('u1', chunk(sine(200, 200, IN_RATE)))).toBe('rejected');
    expect(h.advance(1000)).toBe(0);
  });
});

describe('a lane after bursts and stalls', () => {
  /** The steady-state output is pinned: this hash was produced by the mixer before the lane repair, from the same input. */
  it('steady real-time input from two people is bit-identical to the mixer before the repair', () => {
    const h = harness();
    const hash = createHash('sha1');
    const tone = sine(440, 20, IN_RATE);
    for (let k = 0; k < 500; k += 1) { h.wall.now += 20; h.mixer.push('a', chunk(tone)); h.mixer.push('b', chunk(tone)); h.mixer.tick(); }
    for (const f of h.frames) hash.update(f);
    expect(hash.digest('hex')).toBe('12740c9817c5080ed7310deecfd0dc24b9bab819');
    expect(h.mixer.stats.overrunChunks + h.mixer.stats.lateChunks).toBe(0);
  });

  const loud = (frames: Buffer[]) => frames.map((f) => pcmToInt16(f).some((v) => Math.abs(v) > 100));

  it('bursts totalling 3 s, then normal pacing: the participant is heard again within 500 ms', () => {
    const h = harness();
    for (let i = 0; i < 15; i += 1) h.mixer.push('a', chunk(sine(300, 200, IN_RATE)));
    expect(h.mixer.stats.leadDroppedChunks).toBeGreaterThan(0);
    h.advance(3000);
    h.frames.length = 0;
    const tone = sine(300, 20, IN_RATE);
    for (let k = 0; k < 100; k += 1) { h.advance(20); h.mixer.push('a', chunk(tone)); h.mixer.tick(); }
    const first = loud(h.frames).indexOf(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first * FRAME_MS).toBeLessThan(500);
    // And it keeps being heard to the end: the lane does not run away.
    expect(loud(h.frames).slice(-3)).toEqual([true, true, true]);
  });

  it('a participant who stalls for 5 s and resumes is heard at once', () => {
    const h = harness();
    const tone = sine(300, 20, IN_RATE);
    for (let k = 0; k < 20; k += 1) { h.advance(20); h.mixer.push('a', chunk(tone)); }
    h.advance(5000);
    h.frames.length = 0;
    for (let k = 0; k < 20; k += 1) { h.advance(20); expect(h.mixer.push('a', chunk(tone))).toBe('placed'); h.mixer.tick(); }
    h.advance(400);
    expect(loud(h.frames).indexOf(true)).toBeLessThanOrEqual(3);
  });

  it('counts a late chunk once, and an overrun does not move the write position', () => {
    const h = harness();
    h.advance(3000);
    expect(h.mixer.push('a', chunk(sine(300, 200, IN_RATE)), 1000)).toBe('late');
    expect(h.mixer.stats.lateChunks).toBe(1);
    // The lane starts over at arrival rather than staying behind: the next on-time chunk is placed.
    expect(h.mixer.push('a', chunk(sine(300, 200, IN_RATE)))).toBe('placed');
    expect(h.mixer.stats.lateChunks).toBe(1);
    let overrun = 0;
    for (let i = 0; i < 30; i += 1) if (h.mixer.push('b', chunk(sine(300, 200, IN_RATE))) === 'overrun') overrun += 1;
    expect(overrun).toBeGreaterThan(0);
    expect(h.mixer.stats.overrunChunks).toBe(overrun);
  });
});

describe('the voiced timeline on the mixer\'s clock', () => {
  /** Voiced spans of what the provider would hear, read from the emitted frames themselves. */
  const heard = (frames: Buffer[]): Array<{ startMs: number; endMs: number }> => {
    const spans: Array<{ startMs: number; endMs: number }> = [];
    frames.forEach((f, k) => {
      const s = pcmToInt16(f); let sum = 0; for (const v of s) sum += v * v;
      if (Math.sqrt(sum / s.length) > 400) {
        const last = spans[spans.length - 1];
        if (last && last.endMs === k * FRAME_MS) last.endMs = (k + 1) * FRAME_MS; else spans.push({ startMs: k * FRAME_MS, endMs: (k + 1) * FRAME_MS });
      }
    });
    return spans;
  };

  function run(turns: Array<{ who: string; fromMs: number; ms: number }>, totalMs: number) {
    const timeline = new VoicedTimeline();
    const frames: Buffer[] = [];
    const wall = { now: 5_000 };
    const mixer = new CallMixer({ clock: () => wall.now, onFrame: (f) => frames.push(f), onPlaced: (u, pcm, atMs) => timeline.feed(u, pcm, OUT_RATE, atMs) });
    const start = wall.now;
    // Real-time pace, 200 ms at a time: each speaker's chunks only while they speak (a tap sends nothing in silence).
    for (let t = 0; t < totalMs; t += 200) {
      wall.now = start + t + 200;
      for (const turn of turns) {
        if (t >= turn.fromMs && t < turn.fromMs + turn.ms) {
          const hz = 200 + 150 * turns.indexOf(turn);
          mixer.push(turn.who, int16ToPcm(sine(hz, 200, IN_RATE, 8000, (t - turn.fromMs) * 16)));
        }
      }
      mixer.tick();
    }
    wall.now = start + totalMs + 1500; mixer.tick();
    return { timeline, frames };
  }

  it('three speakers taking turns give three correctly attributed pieces', () => {
    const { timeline, frames } = run([
      { who: 'ana', fromMs: 400, ms: 1600 }, { who: 'ben', fromMs: 3000, ms: 1400 }, { who: 'cy', fromMs: 5400, ms: 1800 },
    ], 8000);
    const spans = heard(frames);
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => timeline.attribute(s).userId)).toEqual(['ana', 'ben', 'cy']);
    expect(spans.map((s) => timeline.attribute(s).speakers)).toEqual([['ana'], ['ben'], ['cy']]);
  });

  it('overlap puts both people in `speakers`', () => {
    const { timeline, frames } = run([
      { who: 'ana', fromMs: 400, ms: 2400 }, { who: 'ben', fromMs: 1200, ms: 2400 },
    ], 5000);
    const spans = heard(frames);
    expect(spans).toHaveLength(1);
    const who = timeline.attribute(spans[0]!);
    expect(who.speakers.sort()).toEqual(['ana', 'ben']);
  });

  it('a new session starts a new time base: a fresh mixer and timeline begin at zero', () => {
    const a = run([{ who: 'ana', fromMs: 0, ms: 1000 }], 2000);
    const b = run([{ who: 'ben', fromMs: 0, ms: 1000 }], 2000);
    expect(a.timeline.attribute(heard(a.frames)[0]!).userId).toBe('ana');
    expect(b.timeline.attribute(heard(b.frames)[0]!).userId).toBe('ben');
    expect(heard(b.frames)[0]!.startMs).toBeLessThan(1000);
  });
});

describe('no audio is written anywhere', () => {
  it('the audio path (sink route, intake, mixer, timeline, session send) has no file write and no audio in a log line', () => {
    const files = ['mixer.ts', 'audio-intake.ts', 'attribution.ts', 'live-session.ts', 'media.ts', '../../routes/meeting-assistant-sink.ts'];
    for (const f of files) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''");
      expect(`${f}: ${/from 'node:fs|from "fs"|from 'fs'|from 'node:fs\/promises'|writeFile|appendFile|createWriteStream|writeSync/.test(code)}`).toBe(`${f}: false`);
      expect(`${f}: ${/console\.(log|info|debug|warn|error)\([^)]*(pcm|chunk|audio|body|req\.body)/.test(code)}`).toBe(`${f}: false`);
    }
  });
});

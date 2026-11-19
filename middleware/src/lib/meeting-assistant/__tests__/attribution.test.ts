import { attribute, estimateLag, lagSample, splitBySpeaker, transcriptLag, TranscriptLag, VoicedTimeline, type VoicedInterval } from '../attribution.js';

const iv = (userId: string, startMs: number, endMs: number): VoicedInterval => ({ userId, startMs, endMs });

describe('attribute', () => {
  it('a clean turn belongs to the one who was voiced', () => {
    const a = [iv('alice', 1000, 4000), iv('bob', 5000, 8000)];
    expect(attribute(a, { startMs: 1200, endMs: 3800 })).toEqual({ userId: 'alice', speakers: ['alice'] });
    expect(attribute(a, { startMs: 5200, endMs: 7800 })).toEqual({ userId: 'bob', speakers: ['bob'] });
  });

  it('overlap lists both, the one voiced longer first; the third who barely spoke is left out', () => {
    const a = [iv('alice', 1000, 6000), iv('bob', 4500, 6000), iv('carol', 1000, 1100)];
    expect(attribute(a, { startMs: 1000, endMs: 6000 })).toEqual({ userId: 'alice', speakers: ['alice', 'bob'] });
  });

  it('a line in which someone else spoke a sentence over the primary (2 s or more) names nobody: its words cannot be told apart', () => {
    const a = [iv('alice', 1000, 6000), iv('bob', 3000, 6000)];
    expect(attribute(a, { startMs: 1000, endMs: 6000 })).toEqual({ userId: null, speakers: ['alice', 'bob'] });
  });

  it('the threshold is the smaller of 30% of the span and 400 ms', () => {
    // 10 s span: 30% is 3 s but the cap is 400 ms, so 450 ms of the other voice counts.
    const long = [iv('alice', 0, 10_000), iv('bob', 9_000, 9_450)];
    expect(attribute(long, { startMs: 0, endMs: 10_000 }).speakers).toEqual(['alice', 'bob']);
    expect(attribute([iv('alice', 0, 10_000), iv('bob', 9_000, 9_350)], { startMs: 0, endMs: 10_000 }).speakers).toEqual(['alice']);
    // 1 s span: 30% is 300 ms.
    expect(attribute([iv('alice', 0, 1000), iv('bob', 0, 310)], { startMs: 0, endMs: 1000 }).speakers).toEqual(['alice', 'bob']);
    expect(attribute([iv('alice', 0, 1000), iv('bob', 0, 250)], { startMs: 0, endMs: 1000 }).speakers).toEqual(['alice']);
  });

  it('a speaker who joins late has nothing before they joined and is attributed after', () => {
    const a = [iv('alice', 0, 20_000), iv('dave', 30_000, 34_000)];
    expect(attribute(a, { startMs: 10_000, endMs: 14_000 }).userId).toBe('alice');
    expect(attribute(a, { startMs: 30_200, endMs: 33_800 })).toEqual({ userId: 'dave', speakers: ['dave'] });
  });

  it('allows for the transcript running up to 2 s late, and no more', () => {
    const a = [iv('alice', 1000, 3000)];
    // Stamped 600 ms late: the audio was 1000-3000, the piece says 1600-3600.
    expect(attribute(a, { startMs: 1600, endMs: 3600 }).userId).toBe('alice');
    // A short piece 800 ms past the voice: found by widening the window 2 s back.
    expect(attribute(a, { startMs: 3800, endMs: 4000 }).userId).toBe('alice');
    // 2.5 s past it: nothing.
    expect(attribute(a, { startMs: 5500, endMs: 5700 }).userId).toBeNull();
  });

  it('silence is unattributed: no user, no speakers', () => {
    expect(attribute([], { startMs: 0, endMs: 2000 })).toEqual({ userId: null, speakers: [] });
    expect(attribute([iv('alice', 10_000, 12_000)], { startMs: 0, endMs: 2000 })).toEqual({ userId: null, speakers: [] });
  });

  it('merges one person\'s overlapping intervals so they are not counted twice', () => {
    const a = [iv('alice', 0, 1000), iv('alice', 500, 1500), iv('bob', 0, 1200)];
    // alice 1500 ms, bob 1200 ms: neither holds 60 % of the voiced time, so no primary.
    expect(attribute(a, { startMs: 0, endMs: 1500 })).toEqual({ userId: null, speakers: ['alice', 'bob'] });
  });

  it('a tie is listed with whoever started first, and has no primary speaker', () => {
    expect(attribute([iv('bob', 500, 1500), iv('alice', 0, 1000)], { startMs: 0, endMs: 1500 })).toEqual({ userId: null, speakers: ['alice', 'bob'] });
  });
});

/** 16-bit mono PCM: `ms` of a square wave at `amp`, or silence when `amp` is 0. */
function pcm(ms: number, amp: number, rate = 16_000): Buffer {
  const n = Math.round((ms / 1000) * rate), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE(amp === 0 ? 0 : (i % 40 < 20 ? amp : -amp), i * 2);
  return b;
}

describe('VoicedTimeline', () => {
  it('turns voiced frames into intervals, bridging short pauses and splitting on long ones', () => {
    const t = new VoicedTimeline();
    t.feed('alice', pcm(1000, 3000), 16_000, 0);
    t.feed('alice', pcm(200, 0), 16_000, 1000);   // under the 300 ms hangover: one interval
    t.feed('alice', pcm(500, 3000), 16_000, 1200);
    t.feed('alice', pcm(800, 0), 16_000, 1700);   // longer than the hangover
    t.feed('alice', pcm(400, 3000), 16_000, 2500);
    expect(t.intervals()).toEqual([
      { userId: 'alice', startMs: 0, endMs: 1700 },
      { userId: 'alice', startMs: 2500, endMs: 2900 },
    ]);
  });

  it('ignores quiet audio, any sample rate works, and a buffer of odd length does not throw', () => {
    const t = new VoicedTimeline();
    t.feed('bob', pcm(1000, 100, 8000), 8000, 0);
    expect(t.intervals()).toEqual([]);
    t.feed('bob', pcm(500, 4000, 48_000), 48_000, 0);
    t.feed('bob', Buffer.concat([pcm(100, 4000), Buffer.from([1])]), 16_000, 600);
    expect(t.intervals().length).toBe(1);
    t.feed('', pcm(100, 4000), 16_000, 0); t.feed('bob', pcm(100, 4000), 0, 0); t.feed('bob', pcm(100, 4000), 16_000, NaN);
    expect(t.intervals().length).toBe(1);
  });

  it('keeps each person apart and attributes a piece from the audio, a late joiner included', () => {
    const t = new VoicedTimeline();
    t.feed('alice', pcm(3000, 3000), 16_000, 0);
    t.feed('bob', pcm(3000, 0), 16_000, 0);
    t.feed('bob', pcm(2000, 3000), 16_000, 3000);       // bob is silent, then speaks
    t.feed('dave', pcm(1000, 3000), 16_000, 20_000);    // dave joins late
    expect(t.attribute({ startMs: 200, endMs: 2800 })).toEqual({ userId: 'alice', speakers: ['alice'] });
    expect(t.attribute({ startMs: 3400, endMs: 5200 })).toEqual({ userId: 'bob', speakers: ['bob'] });
    expect(t.attribute({ startMs: 20_100, endMs: 20_900 }).userId).toBe('dave');
    expect(t.attribute({ startMs: 10_000, endMs: 12_000 })).toEqual({ userId: null, speakers: [] });
  });

  it('drops what is older than ten minutes', () => {
    const t = new VoicedTimeline();
    t.feed('alice', pcm(1000, 3000), 16_000, 0);
    t.feed('alice', pcm(1000, 0), 16_000, 1000);
    t.feed('alice', pcm(1000, 3000), 16_000, 700_000);
    expect(t.intervals()).toEqual([{ userId: 'alice', startMs: 700_000, endMs: 701_000 }]);
  });
});

describe('adaptive noise floor and energy', () => {
  it('a constant-noise microphone is not credited with the real speaker\'s words', () => {
    const t = new VoicedTimeline();
    t.feed('noisy', pcm(30_000, 1500), 16_000, 0);
    t.feed('real', pcm(26_000, 0), 16_000, 0);
    t.feed('real', pcm(3000, 3000), 16_000, 26_000);
    t.feed('real', pcm(1000, 0), 16_000, 29_000);
    const who = t.attribute({ startMs: 26_500, endMs: 28_500 });
    expect(who.userId).toBe('real');
    expect(who.speakers).toEqual(['real']);
  });

  it('two real speakers overlapping are both listed, the louder first', () => {
    const t = new VoicedTimeline();
    t.feed('quiet', pcm(2000, 1500), 16_000, 0);
    t.feed('loud', pcm(2000, 6000), 16_000, 0);
    expect(t.attribute({ startMs: 200, endMs: 1800 }).speakers).toEqual(['loud', 'quiet']);
  });

  it('a quiet real speaker alone is still detected', () => {
    const t = new VoicedTimeline();
    t.feed('soft', pcm(500, 0), 16_000, 0);
    t.feed('soft', pcm(1500, 700), 16_000, 500);
    expect(t.attribute({ startMs: 700, endMs: 1900 })).toEqual({ userId: 'soft', speakers: ['soft'] });
  });

  it('silence is unattributed', () => {
    const t = new VoicedTimeline();
    t.feed('a', pcm(3000, 0), 16_000, 0);
    expect(t.attribute({ startMs: 500, endMs: 2500 })).toEqual({ userId: null, speakers: [] });
  });

  it('attribute ranks by energy and drops anyone under a quarter of the loudest', () => {
    const lv = (userId: string, startMs: number, endMs: number, level: number): VoicedInterval => ({ userId, startMs, endMs, level });
    expect(attribute([lv('hum', 0, 2000, 400), lv('talk', 500, 1500, 4000)], { startMs: 0, endMs: 2000 }, 0))
      .toEqual({ userId: 'talk', speakers: ['talk'] });
    expect(attribute([lv('a', 0, 2000, 1000), lv('b', 500, 1500, 1500)], { startMs: 0, endMs: 2000 }, 0).speakers).toEqual(['a', 'b']);
  });
});

describe('primary speaker (a request spoken over someone)', () => {
  it('a request over a third to a half overlap names the one who spoke the whole line', () => {
    for (const overlap of [1 / 3, 0.4, 0.5]) {
      const end = 3000, ov = Math.round(end * overlap);
      const a = [iv('alice', 0, end), iv('bob', end - ov, end + 1500)];
      expect(attribute(a, { startMs: 0, endMs: end })).toEqual({ userId: 'alice', speakers: ['alice', 'bob'] });
    }
  });

  it('two people starting together have no primary speaker', () => {
    expect(attribute([iv('alice', 0, 2000), iv('bob', 0, 2000)], { startMs: 0, endMs: 2000 }).userId).toBeNull();
  });

  it('a neighbour four times as loud for a small part of the line does not outrank the speaker', () => {
    const lv = (userId: string, startMs: number, endMs: number, level: number, noiseFloor: number): VoicedInterval => ({ userId, startMs, endMs, level, noiseFloor });
    const a = [lv('alice', 0, 3000, 1000, 100), lv('bob', 2000, 3000, 4000, 100)];
    expect(attribute(a, { startMs: 0, endMs: 3000 }).userId).toBe('alice');
  });

  it('key clicks joined into one stretch count only their voiced part', () => {
    // bob: a 3 s stretch that was voiced for 400 ms in all; alice spoke 1.5 s of it.
    const clicks: VoicedInterval = { userId: 'bob', startMs: 0, endMs: 3000, level: 3000, voicedMs: 400 };
    const talk: VoicedInterval = { userId: 'alice', startMs: 500, endMs: 2000, level: 1000, voicedMs: 1500 };
    expect(attribute([clicks, talk], { startMs: 0, endMs: 3000 })).toMatchObject({ userId: 'alice' });
  });
});

// The paid scenario runs of 14 November (times only): reported turns started 0.5 to 1.4 s after the voice that spoke them.
describe('the provider\'s transcript lag', () => {
  const iv = (userId: string, startMs: number, endMs: number): VoicedInterval => ({ userId, startMs, endMs });
  it('is measured from whole turns one person spoke, and is the median of the recent samples', () => {
    expect(lagSample([iv('vera', 37_544, 40_264), iv('nora', 41_827, 43_087)], 'vera', { startMs: 38_800, endMs: 41_400 })).toBe(1_256);
    expect(lagSample([iv('vera', 37_544, 40_264)], 'vera', { startMs: 38_800, endMs: 41_400 }, 4_000)).toBeNull(); // strays from the estimate
    expect(lagSample([iv('mia', 25_389, 25_849)], 'mia', { startMs: 26_600, endMs: 26_800 })).toBeNull(); // too short to measure
    expect(transcriptLag([])).toBe(0);
    expect(transcriptLag([1_256])).toBe(1_256);
    expect(transcriptLag([1_256, 973, 1_331])).toBe(1_256);
  });
  it('follows a lag that grows by 1.3 s a minute over ten minutes, as the paid runs saw', () => {
    const who = ['vera', 'nora', 'mia'];
    const intervals: VoicedInterval[] = [];
    const samples: number[] = [];
    let right = 0;
    for (let k = 0; k < 80; k += 1) {
      const start = 5_000 + k * 7_400, end = start + 3_000, userId = who[k % 3]!;
      intervals.push(iv(userId, start, end));
      const actual = 1_000 + Math.round(start * 0.0217); // 1.3 s a minute
      const span = { startMs: start + actual, endMs: end + actual - 200 };
      const lag = transcriptLag(samples);
      if (attribute(intervals, { startMs: span.startMs - lag, endMs: span.endMs - lag }).userId === userId) right += 1;
      const sample = lagSample(intervals, userId, span, lag);
      if (sample !== null) { samples.push(sample); if (samples.length > 5) samples.shift(); }
    }
    expect(right).toBeGreaterThanOrEqual(78);
    expect(Math.abs(transcriptLag(samples) - (1_000 + Math.round((5_000 + 79 * 7_400) * 0.0217)))).toBeLessThan(400);
  });

  it('moved back by it, a one-word "Milo?" lands on the person who said it', () => {
    const intervals = [iv('mia', 25_389, 25_849), iv('vera', 37_544, 40_264)];
    expect(attribute(intervals, { startMs: 26_600 - 1_200, endMs: 26_800 - 1_200 }).userId).toBe('mia');
  });
  it('a word or two at the edge of a turn that the word times put on the neighbouring voice does not split it off', () => {
    const intervals = [iv('nora', 40_595, 42_995), iv('vera', 43_507, 45_287)];
    const parts = [{ text: ' Milo, what', startMs: 42_800, endMs: 43_100 }, { text: ' is', startMs: 43_100, endMs: 43_400 }, { text: ' three plus', startMs: 43_400, endMs: 44_400 }, { text: ' three', startMs: 44_400, endMs: 45_400 }];
    expect(splitBySpeaker(intervals, parts)).toEqual([{ text: 'Milo, what is three plus three', startMs: 42_800, endMs: 45_400 }]);
  });

  it('a turn holding two voices splits where the voice changes', () => {
    const intervals = [iv('vera', 21_584, 24_664), iv('nora', 25_065, 27_585)];
    const parts = [{ text: ' Milo, create', startMs: 21_600, endMs: 23_000 }, { text: ' a work item', startMs: 23_000, endMs: 24_600 }, { text: '. Milo, how is', startMs: 25_200, endMs: 26_400 }, { text: ' the weather', startMs: 26_400, endMs: 27_500 }];
    expect(splitBySpeaker(intervals, parts)).toEqual([{ text: 'Milo, create a work item', startMs: 21_600, endMs: 24_600 }, { text: 'Milo, how is the weather', startMs: 25_200, endMs: 27_500 }]);
  });
});

describe('overlapped speech in one heard turn (live interview, 17 November)', () => {
  // The voiced intervals of the paid walk's first turn (13.2 to 23.6 s): the candidate alone, then the lead's question spoken over
  // the candidate's next sentence. Before, the whole turn was stored as the candidate's with the lead's words in it.
  const G = 'guest:inv-1', L = 'u-lead';
  const intervals = [iv(G, 12_445, 15_525), iv(G, 15_905, 19_265), iv(L, 16_727, 17_607), iv(L, 17_947, 19_287), iv(G, 19_585, 20_745), iv(L, 19_667, 21_967), iv(G, 21_065, 22_905)];
  const parts = Array.from({ length: 26 }, (_, i) => ({ text: ` w${i}`, startMs: 13_200 + i * 400, endMs: 13_600 + i * 400 }));

  it('the candidate\'s clean stretch is the candidate\'s line; the overlapped stretch is a line of its own that names nobody', () => {
    const pieces = splitBySpeaker(intervals, parts);
    expect(pieces.length).toBeGreaterThan(1);
    const first = attribute(intervals, pieces[0]!);
    expect(first.userId).toBe(G);
    expect(pieces[0]!.endMs).toBeLessThanOrEqual(16_800);
    // No stored line credits the lead's speech to the candidate: every piece that covers the lead's voice names nobody (or the lead).
    for (const p of pieces.slice(1)) {
      const a = attribute(intervals, p);
      if (a.speakers.includes(L)) expect(a.userId === null || a.userId === L).toBe(true);
    }
  });

  it('the whole turn, attributed as one line, names nobody', () => {
    expect(attribute(intervals, { startMs: 13_200, endMs: 23_600 })).toEqual({ userId: null, speakers: [G, L] });
  });

  it('a request spoken over the tail of someone\'s sentence still names the one who asked', () => {
    const a = [iv('vera', 0, 6000), iv('mia', 5200, 7300)];
    const req = Array.from({ length: 6 }, (_, i) => ({ text: ` r${i}`, startMs: 5200 + i * 350, endMs: 5550 + i * 350 }));
    const before = Array.from({ length: 12 }, (_, i) => ({ text: ` v${i}`, startMs: i * 430, endMs: (i + 1) * 430 }));
    const pieces = splitBySpeaker(a, [...before, ...req]);
    const last = pieces[pieces.length - 1]!;
    expect(last.text).toContain('r5');
    expect(attribute(a, last).userId).toBe('mia');
  });
});

describe('the lag measured from the stamps and the voices, without knowing who spoke', () => {
  // Two people alternating with 0.4 s between them, a 3 s pause every fourth turn; a stamp every 400 ms of speech, put on the words
  // `lag` after they were spoken.
  const talk = (lag: number) => {
    const intervals: VoicedInterval[] = [], stamps: Array<{ startMs: number; endMs: number }> = [];
    let t = 10_000;
    for (let k = 0; k < 16; k += 1) {
      const len = 1_500 + (k % 3) * 1_200;
      intervals.push(iv(k % 2 ? 'lead' : 'cand', t, t + len));
      for (let w = t + 200; w < t + len; w += 400) stamps.push({ startMs: w + lag, endMs: w + lag + 200 });
      t += len + (k % 4 === 3 ? 3_000 : 400);
    }
    return { intervals, stamps };
  };
  it('finds a lag of a few seconds that the per-turn sample cannot reach', () => {
    for (const lag of [300, 1_500, 4_800]) {
      const { intervals, stamps } = talk(lag);
      expect(Math.abs(estimateLag(intervals, stamps)! - lag)).toBeLessThanOrEqual(300);
    }
  });
  it('says nothing from a handful of stamps, or when no lag puts the stamps on a voice', () => {
    const { intervals, stamps } = talk(1_500);
    expect(estimateLag(intervals, stamps.slice(0, 5))).toBeNull();
    expect(estimateLag([iv('cand', 0, 500)], stamps)).toBeNull();
  });
  it('a wrong first sample does not stick: the estimate replaces it, and later samples are not taken', () => {
    const { intervals, stamps } = talk(2_500);
    const lag = new TranscriptLag();
    lag.sample([iv('cand', 9_000, 12_000)], 'cand', { startMs: 8_500, endMs: 11_000 });
    expect(lag.current()).toBe(-500);
    lag.heard(stamps);
    expect(Math.abs(lag.update(intervals) - 2_500)).toBeLessThanOrEqual(300);
    lag.sample([iv('cand', 9_000, 12_000)], 'cand', { startMs: 8_500, endMs: 11_000 });
    expect(Math.abs(lag.current() - 2_500)).toBeLessThanOrEqual(300);
  });
});

describe('the lag is not guessed when the voices have no silence to pin it down (review of 18 November, item 1)', () => {
  // A repeatable stream of numbers, so each shape is the same on every run.
  const numbers = (seed: number) => () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
  const stampsOf = (from: number, to: number, lag: number) => {
    const out: Array<{ startMs: number; endMs: number }> = [];
    for (let w = from + 200; w < to; w += 400) out.push({ startMs: w + lag, endMs: w + lag + 200 });
    return out;
  };
  // Two people alternating with 0 to `maxGap` ms between them and no longer pause: every lag puts the stamps on someone's voice.
  const fastTurns = (lag: number, seed: number, maxGap = 300) => {
    const r = numbers(seed), intervals: VoicedInterval[] = [], stamps: Array<{ startMs: number; endMs: number }> = [];
    let t = 10_000;
    for (let k = 0; k < 30; k += 1) {
      const len = 1_500 + Math.round(r() * 3_000);
      intervals.push(iv(k % 2 ? 'lead' : 'cand', t, t + len));
      stamps.push(...stampsOf(t, t + len, lag));
      t += len + Math.round(r() * maxGap);
    }
    return { intervals, stamps };
  };

  it('fast turns with 0 to 300 ms between speakers: no estimate, or the true one; never a lag of ten seconds', () => {
    for (let seed = 1; seed <= 24; seed += 1) {
      const { intervals, stamps } = fastTurns(3_000, seed);
      const e = estimateLag(intervals, stamps);
      if (e !== null) expect(Math.abs(e - 3_000)).toBeLessThanOrEqual(500);
    }
  });

  it('one microphone voiced the whole time (a fan, an open mic): no estimate', () => {
    const intervals: VoicedInterval[] = [iv('fan', 0, 120_000)], stamps: Array<{ startMs: number; endMs: number }> = [];
    let t = 10_000;
    for (let k = 0; k < 16; k += 1) {
      const len = 1_500 + (k % 3) * 1_200;
      intervals.push(iv(k % 2 ? 'lead' : 'cand', t, t + len));
      stamps.push(...stampsOf(t, t + len, 2_000));
      t += len + (k % 4 === 3 ? 3_000 : 400);
    }
    expect(estimateLag(intervals, stamps)).toBeNull();
  });

  it('one person speaking a minute without a pause: no estimate', () => {
    expect(estimateLag([iv('cand', 10_000, 70_000)], stampsOf(10_000, 70_000, 1_500))).toBeNull();
  });

  it('an estimate more than 2 s from the one before, inside the same minute, is not taken: the lag in use stays', () => {
    const lag = new TranscriptLag();
    const early = [iv('cand', 10_000, 12_000), iv('lead', 15_000, 17_000), iv('cand', 20_000, 22_000)];
    lag.heard(early.flatMap((i) => stampsOf(i.startMs, i.endMs, 1_500)));
    expect(Math.abs(lag.update(early) - 1_500)).toBeLessThanOrEqual(300);
    const first = lag.current();
    // Forty seconds on, stamps that the pauses fit 4 s later: the drift is at most about a second a minute, so this is the fit fooled.
    const later = [iv('lead', 30_000, 36_000), iv('cand', 39_000, 45_000), iv('lead', 48_000, 54_000), iv('cand', 57_000, 63_000)];
    lag.heard(later.flatMap((i) => stampsOf(i.startMs, i.endMs, 5_500)));
    expect(Math.abs(estimateLag([...early, ...later], [...early, ...later].flatMap((i) => stampsOf(i.startMs, i.endMs, i.startMs < 30_000 ? 1_500 : 5_500)))! - 5_500)).toBeLessThanOrEqual(500);
    expect(lag.update([...early, ...later])).toBe(first);
    expect(lag.measured).toBe(false);
  });

  it('counts as measured only while an estimate from the stamps stands, under a minute old (a writing tool waits for it)', () => {
    const lag = new TranscriptLag();
    expect([lag.used, lag.measured]).toEqual([false, false]);
    // Before any estimate the lag in use is a per-turn sample, or 0: not measured.
    lag.sample([iv('cand', 9_000, 12_000)], 'cand', { startMs: 10_000, endMs: 12_000 });
    lag.heard([{ startMs: 10_200, endMs: 10_400 }]);
    lag.update([iv('cand', 9_000, 12_000)]);
    expect([lag.used, lag.current(), lag.measured]).toEqual([true, 1_000, false]);
    const turns = [iv('cand', 20_000, 22_000), iv('lead', 25_000, 27_000), iv('cand', 30_000, 32_000)];
    lag.heard(turns.flatMap((i) => stampsOf(i.startMs, i.endMs, 1_500)));
    lag.update(turns);
    expect(lag.measured).toBe(true);
    // A minute of talk with no pause: no new estimate, and the old one is too old to vouch for the lag.
    lag.heard(stampsOf(33_000, 100_000, 1_500));
    lag.update([...turns, iv('cand', 33_000, 100_000)]);
    expect(lag.measured).toBe(false);
  });
});

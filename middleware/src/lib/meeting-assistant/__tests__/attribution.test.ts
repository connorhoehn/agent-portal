import { attribute, VoicedTimeline, type VoicedInterval } from '../attribution.js';

const iv = (userId: string, startMs: number, endMs: number): VoicedInterval => ({ userId, startMs, endMs });

describe('attribute', () => {
  it('a clean turn belongs to the one who was voiced', () => {
    const a = [iv('alice', 1000, 4000), iv('bob', 5000, 8000)];
    expect(attribute(a, { startMs: 1200, endMs: 3800 })).toEqual({ userId: 'alice', speakers: ['alice'] });
    expect(attribute(a, { startMs: 5200, endMs: 7800 })).toEqual({ userId: 'bob', speakers: ['bob'] });
  });

  it('overlap lists both, the one voiced longer first; the third who barely spoke is left out', () => {
    const a = [iv('alice', 1000, 6000), iv('bob', 3000, 6000), iv('carol', 1000, 1100)];
    expect(attribute(a, { startMs: 1000, endMs: 6000 })).toEqual({ userId: 'alice', speakers: ['alice', 'bob'] });
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

  it('allows for the transcript running up to 600 ms late, and no more', () => {
    const a = [iv('alice', 1000, 3000)];
    // Stamped 600 ms late: the audio was 1000-3000, the piece says 1600-3600.
    expect(attribute(a, { startMs: 1600, endMs: 3600 }).userId).toBe('alice');
    // 1 s late: only the tail overlaps the window, and the 3600+ part has nothing, so the overlap is under the share of the piece.
    expect(attribute(a, { startMs: 3800, endMs: 4000 }).userId).toBeNull();
  });

  it('silence is unattributed: no user, no speakers', () => {
    expect(attribute([], { startMs: 0, endMs: 2000 })).toEqual({ userId: null, speakers: [] });
    expect(attribute([iv('alice', 10_000, 12_000)], { startMs: 0, endMs: 2000 })).toEqual({ userId: null, speakers: [] });
  });

  it('merges one person\'s overlapping intervals so they are not counted twice', () => {
    const a = [iv('alice', 0, 1000), iv('alice', 500, 1500), iv('bob', 0, 1200)];
    expect(attribute(a, { startMs: 0, endMs: 1500 })).toEqual({ userId: 'alice', speakers: ['alice', 'bob'] });
  });

  it('a tie goes to whoever started first', () => {
    expect(attribute([iv('bob', 500, 1500), iv('alice', 0, 1000)], { startMs: 0, endMs: 1500 }).userId).toBe('alice');
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

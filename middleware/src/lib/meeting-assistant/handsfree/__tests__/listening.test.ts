// The listening side on a scripted transcriber and a fake clock: the name on a delta, misheard forms, consent, bounded reopen.
import { createListeningSide, normaliseName } from '../listening.js';
import { HANDSFREE, type HandsfreeClock, type ListeningEvents, type PersonTranscriber } from '../types.js';

class FakeClock implements HandsfreeClock {
  t = 0; private timers: Array<{ at: number; fn: () => void; id: number }> = []; private n = 0;
  nowMs(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = ++this.n; this.timers.push({ at: this.t + ms, fn, id }); return id; }
  clearTimeout(h: unknown): void { this.timers = this.timers.filter((x) => x.id !== h); }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next); this.t = next.at; next.fn();
    }
    this.t = end;
  }
}

class ScriptedStream implements PersonTranscriber {
  appended = 0; closed = false;
  private ls: Record<string, Set<(e: never) => void>> = { delta: new Set(), final: new Set(), closed: new Set() };
  append(pcm: Buffer): void { if (!this.closed) this.appended += pcm.length; }
  on(type: string, fn: (e: never) => void): () => void { this.ls[type]!.add(fn); return () => this.ls[type]!.delete(fn); }
  emit(type: string, e: unknown): void { for (const fn of [...this.ls[type]!]) (fn as (x: unknown) => void)(e); }
  get streamMs(): number { return this.appended / 48; }
  delta(itemId: string, delta: string): void { this.emit('delta', { itemId, delta, streamMs: this.streamMs }); }
  final(itemId: string, text: string, startStreamMs: number, endStreamMs: number): void { this.emit('final', { itemId, text, startStreamMs, endStreamMs }); }
  drop(): void { this.closed = true; this.emit('closed', { error: 'server closed' }); }
  async close(): Promise<void> { this.closed = true; }
}

const voiced = (n: number): Buffer => { const b = Buffer.alloc(n * 48); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 4 ? 3000 : -3000, i); return b; };
const quiet = (n: number): Buffer => Buffer.alloc(n * 48);
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(consented: (u: string) => boolean = () => true, factory?: () => Promise<PersonTranscriber>) {
  const clock = new FakeClock();
  const streams: ScriptedStream[] = [];
  const keywords: string[][] = [];
  const side = createListeningSide({
    callId: 'c1', clock, consented, epochNow: () => 1_700_000_000_000,
    transcriber: factory ?? (async (input) => { keywords.push([...input.keywords]); const s = new ScriptedStream(); streams.push(s); return s; }),
  });
  const seen: { [K in keyof ListeningEvents]: Array<ListeningEvents[K]> } = { line: [], name: [], sentence: [], words: [], lane: [], frame: [] };
  for (const k of Object.keys(seen) as Array<keyof ListeningEvents>) side.on(k, (e) => (seen[k] as unknown[]).push(e));
  /** Place `pcm` for `user` at session ms `at` in 100 ms pieces, moving the clock with it. */
  const feed = (user: string, pcm: Buffer, at: number): void => {
    for (let o = 0; o < pcm.length; o += HANDSFREE.frameBytes) { clock.t = at + o / 48; side.placed(user, pcm.subarray(o, o + HANDSFREE.frameBytes), at + o / 48); }
    clock.t = at + pcm.length / 48;
  };
  return { clock, side, streams, seen, feed, keywords };
}

describe('the listening side', () => {
  it('opens a stream with the name as a keyword', async () => {
    const { side, keywords, seen } = setup();
    await side.open('u1', 'Una');
    expect(keywords[0]).toEqual(expect.arrayContaining(['Milo', 'Mylo']));
    expect(seen.lane).toEqual([{ userId: 'u1', state: 'up' }]);
  });

  it('"Milo" on a delta emits name with the right person and the sentence start, once per sentence', async () => {
    const { side, streams, seen, feed } = setup();
    await side.open('u1', 'Una');
    await side.open('u2', 'Hugo');
    feed('u2', quiet(3000), 0);
    feed('u1', quiet(2000), 0);
    feed('u1', voiced(800), 2000); // speech from session 2000
    const s = streams[0]!;
    s.delta('i1', 'Hey');
    s.delta('i1', ' Milo,');
    expect(seen.name).toHaveLength(1);
    expect(seen.name[0]).toMatchObject({ userId: 'u1', sentenceStartMs: 1900, nameEndMs: 2800, textSoFar: 'Hey Milo,' });
    feed('u1', voiced(500), 2800);
    s.delta('i1', ' what time is it?');
    expect(seen.name).toHaveLength(1);
    s.final('i1', 'Hey Milo, what time is it?', 2000, 3300);
    expect(seen.sentence).toEqual([expect.objectContaining({ userId: 'u1', sentenceId: seen.name[0]!.sentenceId, named: true, text: 'Hey Milo, what time is it?', startMs: 1900, endMs: 3300 })]);
    expect(seen.line).toEqual([expect.objectContaining({ callId: 'c1', userId: 'u1', speakerName: 'Una', text: 'Hey Milo, what time is it?', startMs: 1900, endMs: 3300 })]);
    expect(seen.words.map((w) => w.delta)).toEqual(['Hey', ' Milo,', ' what time is it?']);
    expect(seen.words.every((w) => w.userId === 'u1')).toBe(true);
  });

  it('counts the misheard forms', async () => {
    expect(normaliseName('Nilo, what time is it?')).toBe('Milo, what time is it?');
    expect(normaliseName('hey nylo')).toBe('hey milo');
    expect(normaliseName('the Nilometer')).toBe('the Nilometer');
    for (const said of ['Mylo, what is the time?', 'Nilo, what is the time?', 'Hey Nylo, summarise this.']) {
      const { side, streams, seen, feed } = setup();
      await side.open('u1', 'Una');
      feed('u1', voiced(600), 0);
      streams[0]!.delta('a', said);
      expect(seen.name).toHaveLength(1);
    }
  });

  it('a sentence that does not address Milo emits no name', async () => {
    const { side, streams, seen, feed } = setup();
    await side.open('u1', 'Una');
    feed('u1', voiced(600), 0);
    streams[0]!.delta('a', 'Thanks, Milo.');
    streams[0]!.final('a', 'Thanks, Milo.', 0, 600);
    expect(seen.name).toHaveLength(0);
    expect(seen.sentence[0]).toMatchObject({ named: false });
  });

  it('converts stream ms across a long gap the stream never heard', async () => {
    const { side, streams, seen, feed } = setup();
    await side.open('u1', 'Una');
    feed('u1', voiced(500), 1000);
    feed('u1', voiced(500), 60_000); // 59 s away: not streamed as silence
    expect(streams[0]!.streamMs).toBe(1000);
    streams[0]!.final('b', 'Back again.', 500, 1000);
    expect(seen.sentence[0]).toMatchObject({ startMs: 60_000, endMs: 60_500 });
  });

  it('writes the ring and emits frames synchronously; pre-roll never exceeds 10 s', async () => {
    const { side, seen, feed, clock } = setup();
    await side.open('u1', 'Una');
    feed('u1', voiced(15_000), 0);
    expect(seen.frame).toHaveLength(150);
    expect(seen.frame.at(-1)).toMatchObject({ userId: 'u1', atMs: 14_900 });
    expect(side.preRoll('u1', 0)).toHaveLength(100);
    expect(side.preRoll('u1', 13_050)).toHaveLength(20);
    clock.t = 20_000; // nothing new placed for 5 s: the ring reaches back 10 s from now
    expect(side.preRoll('u1', 0)).toHaveLength(50);
    expect(side.preRoll('nobody', 0)).toEqual([]);
  });

  it('no consent, no lane: nothing opened, audio dropped, no frames', async () => {
    let opened = 0;
    const { side, seen, feed } = setup((u) => u !== 'cand', async () => { opened += 1; return new ScriptedStream(); });
    await side.open('cand', 'Cara');
    feed('cand', voiced(1000), 0);
    expect(opened).toBe(0);
    expect(seen.frame).toHaveLength(0);
    expect(side.preRoll('cand', 0)).toEqual([]);
    expect(seen.lane).toEqual([{ userId: 'cand', state: 'down', reason: 'no-consent' }]);
  });

  it('a closed stream reopens, at most 3 times a minute, then again after the minute', async () => {
    const { side, streams, seen, clock, feed } = setup();
    await side.open('u1', 'Una');
    for (let i = 0; i < 3; i += 1) {
      streams.at(-1)!.drop();
      clock.advance(300); await flush();
      expect(streams).toHaveLength(i + 2);
    }
    streams.at(-1)!.drop();
    clock.advance(300); await flush();
    expect(streams).toHaveLength(4);
    expect(seen.lane.at(-1)).toEqual({ userId: 'u1', state: 'down', reason: 'reopen-limit' });
    // The lane is down but the ring still fills (the hold button still routes).
    feed('u1', voiced(200), clock.t);
    expect(side.preRoll('u1', 0).length).toBeGreaterThan(0);
    clock.advance(60_000); await flush();
    expect(streams).toHaveLength(5);
    expect(seen.lane.at(-1)).toEqual({ userId: 'u1', state: 'up' });
    // Events of a replaced stream are ignored.
    streams[0]!.delta('old', 'Milo, hello?');
    expect(seen.name).toHaveLength(0);
  });

  it('a failed open is retried like a close; a configuration error rejects', async () => {
    let calls = 0;
    const { side, seen, clock } = setup(undefined, async () => { calls += 1; if (calls === 1) throw new Error('refused'); return new ScriptedStream(); });
    await side.open('u1', 'Una');
    expect(seen.lane).toEqual([{ userId: 'u1', state: 'down', reason: 'closed' }]);
    clock.advance(300); await flush();
    expect(seen.lane.at(-1)).toEqual({ userId: 'u1', state: 'up' });
    const cfg = setup(undefined, async () => { throw Object.assign(new Error('no key'), { config: true }); });
    await expect(cfg.side.open('u1', 'Una')).rejects.toThrow('no key');
  });

  it('closeLane drops the ring at once; close stops every event', async () => {
    const { side, streams, seen, feed } = setup();
    await side.open('u1', 'Una');
    feed('u1', voiced(500), 0);
    side.closeLane('u1');
    expect(side.preRoll('u1', 0)).toEqual([]);
    expect(streams[0]!.closed).toBe(true);
    expect(seen.lane.at(-1)).toEqual({ userId: 'u1', state: 'down', reason: 'left' });
    await side.open('u2', 'Hugo');
    await side.close();
    const before = seen.frame.length;
    feed('u2', voiced(500), 1000);
    streams[1]!.delta('x', 'Milo, hi');
    expect(seen.frame.length).toBe(before);
    expect(seen.name).toHaveLength(0);
    expect(streams[1]!.closed).toBe(true);
  });
});

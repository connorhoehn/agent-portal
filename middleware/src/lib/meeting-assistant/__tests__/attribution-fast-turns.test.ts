import { readFileSync } from 'fs';
import { join } from 'path';
import { attribute, splitBySpeaker, TranscriptLag, type TranscriptPart, type VoicedInterval } from '../attribution.js';

// A paid interview take of 18 November, replayed by its times only (fixtures/fast-turns-take.json: no words, no audio). The two people
// alternate quickly (median 0.41 s between speakers), and the provider's transcript stamps ran 1.3 s late at the start and almost 5 s
// late nine minutes in. Each heard turn is attributed the way the orchestrator does it (storeInput/storePiece), and every word whose
// true speaker is known must be credited to that speaker.
interface Fixture { intervals: Array<[string, number, number]>; deltas: Array<[number, number, string | null]>; turns: Array<[number, number]> }
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'fast-turns-take.json'), 'utf8')) as Fixture;

function replay(): { right: number; wrong: number; nobody: number; credit: Map<number, string | null> } {
  const tracker = new TranscriptLag();
  const credit = new Map<number, string | null>();
  for (const [from, to] of fx.turns) {
    // What the server knows when the turn is stored: the voices up to the turn's last stamp.
    const known: VoicedInterval[] = fx.intervals.filter(([, s]) => s < to).map(([userId, s, e]) => ({ userId, startMs: s, endMs: Math.min(e, to) }));
    const idx = fx.deltas.map((d, i) => [d, i] as const).filter(([d]) => d[0] >= from && d[0] <= to);
    const parts: TranscriptPart[] = idx.map(([d, i]) => ({ text: ` w${i}`, startMs: d[0], endMs: d[1] }));
    if (!parts.length) continue;
    tracker.heard(parts);
    const lag = tracker.update(known);
    const pieces = parts.length > 1
      ? splitBySpeaker(known, parts.map((p) => ({ ...p, startMs: p.startMs - lag, endMs: p.endMs - lag }))).map((p) => ({ ...p, startMs: p.startMs + lag, endMs: p.endMs + lag }))
      : [{ text: parts[0]!.text, startMs: from, endMs: to }];
    for (const p of pieces) {
      const found = attribute(known, { startMs: p.startMs - lag, endMs: p.endMs - lag });
      const who = 'mixed' in p && p.mixed && found.speakers.length > 1 ? { userId: null, speakers: found.speakers } : found;
      if (pieces.length === 1 && who.userId !== null && who.speakers.length === 1) tracker.sample(known, who.userId, p);
      for (const w of p.text.trim().split(/\s+/)) credit.set(Number(w.slice(1)), who.userId);
    }
  }
  let right = 0, wrong = 0, nobody = 0;
  fx.deltas.forEach(([, , truth], i) => {
    if (!truth || !credit.has(i)) return;
    const c = credit.get(i);
    if (c === truth) right += 1; else if (c === null) nobody += 1; else wrong += 1;
  });
  return { right, wrong, nobody, credit };
}

describe('two people alternating quickly, with the provider\'s stamps running late and drifting (live take, 18 November)', () => {
  it('credits each person\'s words to that person', () => {
    const r = replay();
    const total = r.right + r.wrong + r.nobody;
    expect(total).toBeGreaterThan(400);
    // Before the alignment estimate (one per-turn sample of -0.56 s, then none): 21.8 % of these words went to the other person.
    // With it: 435 of 444 right, 6 to the other person, 3 to nobody.
    expect(r.wrong / total).toBeLessThanOrEqual(0.03);
    expect(r.right / total).toBeGreaterThanOrEqual(0.9);
  });

  it('the candidate\'s clarifying question is the candidate\'s and the lead\'s short answer is the lead\'s (stored the other way round live)', () => {
    const { credit } = replay();
    // Stamps 91.0 to 92.6 s: "...always exactly one answer?" (the candidate); 94.0 s: "Yes, exactly one." (the lead), 0.4 s after it.
    const at = (ms: number) => credit.get(fx.deltas.findIndex((d) => d[0] === ms));
    expect([91_000, 91_200, 91_800, 92_400].map(at)).toEqual(['cand', 'cand', 'cand', 'cand']);
    expect(at(94_000)).toBe('lead');
  });
});

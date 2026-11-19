// The per-person ring: re-cuts any placed piece into session frames, keeps 10 s, never returns more.
import { PersonRing } from '../person-buffer.js';
import { HANDSFREE } from '../types.js';

const ms = (n: number, v = 1000): Buffer => { const b = Buffer.alloc(n * 48); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(v, i); return b; };

describe('PersonRing', () => {
  it('re-cuts pieces of any length at any ms into whole session frames, in order', () => {
    const r = new PersonRing();
    expect(r.write(ms(30), 250)).toEqual([]); // frame 2 partly filled (silence 200-250, voice 250-280)
    const out = r.write(ms(170), 280); // completes frames 2 and 3, leaves 400-450 open
    expect(out.map((f) => f.atMs)).toEqual([200, 300]);
    expect(out.every((f) => f.pcm.length === HANDSFREE.frameBytes)).toBe(true);
    expect(out[0]!.pcm.readInt16LE(0)).toBe(0); // the lead-in before 250 is silence
    expect(out[0]!.pcm.readInt16LE(60 * 48)).toBe(1000);
    expect(r.write(ms(50), 450).map((f) => f.atMs)).toEqual([400]);
  });

  it('fills a short gap with silence and drops audio already placed', () => {
    const r = new PersonRing();
    r.write(ms(100), 0);
    expect(r.write(ms(100), 300).map((f) => f.atMs)).toEqual([100, 200, 300]);
    expect(r.write(ms(100), 300)).toEqual([]); // the same audio again
    expect(r.read(100).length).toBe(3);
    expect(r.read(100)[0]!.readInt16LE(0)).toBe(0);
  });

  it('starts a fresh run after a long gap', () => {
    const r = new PersonRing();
    r.write(ms(150), 0);
    expect(r.write(ms(100), 5_000).map((f) => f.atMs)).toEqual([100, 5_000]);
  });

  it('stops at a sentence end when asked (frames starting before it)', () => {
    const r = new PersonRing();
    r.write(ms(1000), 0); // frames 0..900
    expect(r.read(200, -Infinity, 650)).toHaveLength(5); // 200, 300, 400, 500, 600
    expect(r.read(200, -Infinity, 600)).toHaveLength(4);
    expect(r.read(200)).toHaveLength(8);
  });

  it('never returns more than 10 s, nor below the floor, and copies', () => {
    const r = new PersonRing();
    for (let t = 0; t < 30_000; t += 100) r.write(ms(100), t);
    const all = r.read(0);
    expect(all.length).toBe(HANDSFREE.ringMs / HANDSFREE.frameMs);
    expect(r.read(25_000).length).toBe(50);
    expect(r.read(0, 28_000).length).toBe(20);
    all[0]!.writeInt16LE(7, 0);
    expect(r.read(0)[0]!.readInt16LE(0)).toBe(1000);
    r.clear();
    expect(r.read(0)).toEqual([]);
  });
});

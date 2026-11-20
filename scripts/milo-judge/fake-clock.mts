// A fake clock the turn owner is driven on: nothing waits in real time, timers fire in order as the script advances it.
import { T0 } from './truth.mts';

export interface FakeClock {
  now(): number;
  /** Ms since the script's t0. */
  rel(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Move time forward to `rel` ms, firing every timer due on the way, in order. */
  advanceTo(rel: number): Promise<void>;
}

export function fakeClock(): FakeClock {
  let t = T0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    rel: () => t - T0,
    setTimeout(fn, ms) { seq += 1; timers.set(seq, { at: t + Math.max(0, ms), fn }); return seq; },
    clearTimeout(id) { timers.delete(id); },
    async advanceTo(rel) {
      const target = T0 + rel;
      for (;;) {
        let nextId: number | null = null;
        for (const [id, tm] of timers) if (tm.at <= target && (nextId === null || tm.at < timers.get(nextId)!.at)) nextId = id;
        if (nextId === null) break;
        const tm = timers.get(nextId)!;
        timers.delete(nextId);
        t = Math.max(t, tm.at);
        tm.fn();
        await Promise.resolve();
      }
      t = Math.max(t, target);
    },
  };
}

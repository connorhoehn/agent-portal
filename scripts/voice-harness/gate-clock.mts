// The gate's clocks: real wall time for live runs, a virtual one for scripted runs (instant, deterministic).
import { performance } from 'node:perf_hooks';

export const HANDSFREE_FRAME_MS = 100;
export const HANDSFREE_FRAME_BYTES = 4_800; // 24 kHz mono PCM16, 100 ms (handsfree/types.ts HANDSFREE)

export interface Clock { now(): number; sleepUntil(ms: number): Promise<void> }

export const realClock: Clock = {
  now: () => performance.now(),
  sleepUntil: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms - performance.now()))),
};

export function virtualClock(): Clock {
  let t = 0;
  return { now: () => t, sleepUntil: async (ms) => { t = Math.max(t, ms); } };
}

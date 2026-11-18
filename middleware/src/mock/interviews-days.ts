// The interviews seed's one calendar (E4 finding 47): every seeded round falls on a working day. `days` counts working
// days from today (Monday to Friday, UTC): 1 is the next working day after today, -1 the last one before it, 0 today
// whatever day it is. Hours are UTC; the seed keeps rounds between 13:00 and 18:00 UTC, a working afternoon in Europe
// and a working morning on the US east coast. Computed on read from the mock clock, so "tomorrow" stays tomorrow.
import { clock } from './core/index.js';

const DAY_MS = 86_400_000;

/** Today's UTC midnight moved `days` working days (Saturday and Sunday skipped), in ms. */
export function workdayMidnight(days: number): number {
  const now = clock.now().getTime();
  let t = now - (now % DAY_MS);
  const step = days < 0 ? -1 : 1;
  for (let left = Math.abs(days); left > 0;) {
    t += step * DAY_MS;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return t;
}

/** `days` working days from today, at `hour:minute:second` UTC. */
export function seedAt(days: number, hour: number, minute = 0, second = 0): string {
  return new Date(workdayMidnight(days) + ((hour * 60 + minute) * 60 + second) * 1000).toISOString();
}

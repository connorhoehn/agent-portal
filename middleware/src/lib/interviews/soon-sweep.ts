// The timer behind "starting soon" (row I5.6). An interval this service owns, on the meeting assistant sweeps' pattern: unref'd,
// bounded work per tick, safe to run twice. It does nothing while the interviews flag is off.
//
// Once only: each ring has a key (round, person, scheduled instant) kept in memory, and the bell's own id is derived from the same
// three (social-notify.ts), so a second tick or a second task in this process cannot ring twice. A restart forgets the keys; the
// bell's id is then the dedupe key in the notification store itself: a person whose inbox already holds that id is not rung
// again (O-043). No table.
import { interviewsEnabled } from './flag.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { dueRings, soonMinutes } from './soon.js';
import { notifyInterviewStartingSoon } from '../social-notify.js';
import { interviewsNowMs } from './clock.js';

export const SOON_TICK_MS = 60_000;
/** Most rings sent in one tick; the rest wait for the next. */
const MAX_PER_TICK = 200;

const rung = new Set<string>();

export interface SoonDeps {
  now: () => number;
  load: () => Promise<Awaited<ReturnType<typeof loadWorld>>>;
  ring: typeof notifyInterviewStartingSoon;
  enabled: () => boolean;
  /** The bell's lead in minutes, read once per tick (INTERVIEWS_SOON_MINUTES). */
  minutes: () => number;
}

const defaults: SoonDeps = { now: interviewsNowMs, load: () => loadWorld(interviewsStore()), ring: notifyInterviewStartingSoon, enabled: interviewsEnabled, minutes: () => soonMinutes() };

/** One pass; returns how many rings it sent. Never throws. */
export async function runSoonTick(deps: Partial<SoonDeps> = {}, rungKeys: Set<string> = rung): Promise<number> {
  const d = { ...defaults, ...deps };
  try {
    if (!d.enabled()) return 0;
    const nowMs = d.now();
    const minutes = d.minutes();
    const world = await d.load();
    // Keys for starts already past cannot come due again: forget them so the set stays small.
    for (const key of rungKeys) {
      const at = Date.parse(key.slice(key.lastIndexOf('|') + 1));
      if (!Number.isFinite(at) || at < nowMs) rungKeys.delete(key);
    }
    const due = dueRings(world.interviews, nowMs, rungKeys, minutes).slice(0, MAX_PER_TICK);
    const byInterview = new Map<string, typeof due>();
    for (const r of due) byInterview.set(r.interview.id, [...(byInterview.get(r.interview.id) ?? []), r]);
    let sent = 0;
    for (const rings of byInterview.values()) {
      const interview = rings[0]!.interview;
      const opening = world.openings.find((o) => o.id === world.applications.find((a) => a.id === interview.applicationId)?.openingId);
      for (const r of rings) rungKeys.add(r.key); // claimed before the await, so an overlapping tick skips them
      await d.ring({
        interviewId: interview.id, scheduledAt: interview.scheduledAt!, minutes,
        openingTitle: opening?.title ?? 'an opening',
        roundName: opening?.kit.rounds.find((x) => x.id === interview.roundId)?.name ?? 'Interview',
        userIds: rings.map((r) => r.userId),
      });
      sent += rings.length;
    }
    return sent;
  } catch (err) {
    console.warn(`[interviews] starting-soon tick failed: ${(err as Error).message}`);
    return 0;
  }
}

/** Start the interval; returns its stopper. */
export function startInterviewsSoonSweep(everyMs = SOON_TICK_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runSoonTick().finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

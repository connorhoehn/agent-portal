// The timer behind the overdue-scorecard reminder (ledger row C-17), on soon-sweep.ts's pattern: an interval this service
// owns, unref'd, bounded work per tick, safe to run twice, doing nothing while the interviews flag is off.
//
// Once only: each ring's key (round, person, end) is kept in memory, and the bell's id is derived from the round and the
// person (social-notify.ts), so a second tick or a second task in this process cannot ring twice. A restart forgets the
// keys; the bell's id is then the dedupe key in the notification store: a person whose inbox already holds it is not rung
// again. No table.
import { interviewsEnabled } from './flag.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { dueOverdue, overdueHours } from './overdue.js';
import { notifyInterviewScorecardOverdue } from '../social-notify.js';
import { interviewsNowMs } from './clock.js';

export const OVERDUE_TICK_MS = 60_000;
/** Most rings sent in one tick; the rest wait for the next. */
const MAX_PER_TICK = 200;

const rung = new Set<string>();

export interface OverdueDeps {
  now: () => number;
  load: () => Promise<Awaited<ReturnType<typeof loadWorld>>>;
  ring: typeof notifyInterviewScorecardOverdue;
  enabled: () => boolean;
  /** The delay in hours, read once per tick (INTERVIEWS_SCORECARD_OVERDUE_HOURS). */
  hours: () => number;
}

const defaults: OverdueDeps = { now: interviewsNowMs, load: () => loadWorld(interviewsStore()), ring: notifyInterviewScorecardOverdue, enabled: interviewsEnabled, hours: () => overdueHours() };

/** One pass; returns how many rings it sent. Never throws. */
export async function runOverdueTick(deps: Partial<OverdueDeps> = {}, rungKeys: Set<string> = rung): Promise<number> {
  const d = { ...defaults, ...deps };
  try {
    if (!d.enabled()) return 0;
    const nowMs = d.now();
    const hours = d.hours();
    const world = await d.load();
    // A key whose round is no longer ended (scored, cancelled, erased) cannot come due again: forget it so the set stays small.
    const stillEnded = new Set(world.interviews.filter((i) => i.state === 'ended').map((i) => i.id));
    for (const key of rungKeys) if (!stillEnded.has(key.slice(0, key.indexOf('|')))) rungKeys.delete(key);
    const due = dueOverdue(world.interviews, world.scorecards, nowMs, rungKeys, hours).slice(0, MAX_PER_TICK);
    const byInterview = new Map<string, typeof due>();
    for (const r of due) byInterview.set(r.interview.id, [...(byInterview.get(r.interview.id) ?? []), r]);
    let sent = 0;
    for (const rings of byInterview.values()) {
      const interview = rings[0]!.interview;
      const opening = world.openings.find((o) => o.id === world.applications.find((a) => a.id === interview.applicationId)?.openingId);
      for (const r of rings) rungKeys.add(r.key); // claimed before the await, so an overlapping tick skips them
      await d.ring({
        interviewId: interview.id, hours,
        openingTitle: opening?.title ?? 'an opening',
        roundName: opening?.kit.rounds.find((x) => x.id === interview.roundId)?.name ?? 'Interview',
        userIds: rings.map((r) => r.userId),
      });
      sent += rings.length;
    }
    return sent;
  } catch (err) {
    console.warn(`[interviews] overdue-scorecard tick failed: ${(err as Error).message}`);
    return 0;
  }
}

/** Start the interval; returns its stopper. */
export function startInterviewsOverdueSweep(everyMs = OVERDUE_TICK_MS): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runOverdueTick().finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

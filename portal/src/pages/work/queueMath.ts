// Pure queue arithmetic for the Work page's pulse strip. No React — testable
// under node:test like the sprint/project format modules.

export interface QueueJobLike {
  status: string;
  botId?: string | null;
  result?: { durationMs?: number } | null;
}

/** Fallback when no finished job carries a duration — roughly what a governed
 *  devbox task takes end-to-end in this stack. */
export const DEFAULT_JOB_MINUTES = 6;

/** Mean duration (minutes) of recently finished jobs, or the default. Uses
 *  only jobs that actually recorded a duration — zeros would drag the
 *  estimate toward "instant", which reads as a lie the moment a job runs. */
export function avgJobMinutes(jobs: QueueJobLike[]): number {
  const ds = jobs
    .map((j) => j.result?.durationMs)
    .filter((d): d is number => typeof d === 'number' && d > 0);
  if (ds.length === 0) return DEFAULT_JOB_MINUTES;
  return ds.reduce((a, b) => a + b, 0) / ds.length / 60_000;
}

/**
 * Minutes until the queue drains: everything waiting takes a full average job
 * each, everything mid-flight is counted as half done, all divided across the
 * workers actually pulling. Null when nothing is queued or processing — "0
 * minutes" would suggest the estimator ran; there is simply nothing to drain.
 */
export function estimateDrainMinutes(
  queued: number,
  processing: number,
  workers: number,
  avgMinutes: number,
): number | null {
  const load = queued + processing * 0.5;
  if (load <= 0) return null;
  return Math.max(1, Math.ceil((load * avgMinutes) / Math.max(workers, 1)));
}

/** The bot ids with a job currently claimed or running — "pulling now". */
export function pullingBotIds(jobs: QueueJobLike[]): Set<string> {
  const out = new Set<string>();
  for (const j of jobs) {
    if ((j.status === 'running' || j.status === 'claimed') && j.botId) out.add(j.botId);
  }
  return out;
}

export interface QueueBotLike {
  enabled: boolean;
  pausedReason: string | null;
}

/**
 * The bots the queue pulse roster renders — every bot returned for this
 * queue, active or paused. The stat strip's "Bots on this queue" count must
 * read this same list's length, not a narrower filter of it: a tile reading
 * 4 over a roster of 5 rows is the count and the list disagreeing about what
 * "on this queue" means.
 */
export function botsOnQueue<T extends QueueBotLike>(bots: T[]): T[] {
  return bots;
}

/** How many of the roster are not currently pulling — paused or disabled. */
export function pausedBotCount<T extends QueueBotLike>(bots: T[]): number {
  return bots.filter((b) => !b.enabled || b.pausedReason != null).length;
}

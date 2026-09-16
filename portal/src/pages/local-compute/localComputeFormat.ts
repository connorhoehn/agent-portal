// Pure formatting for local-compute displays.

import type { ChipTone } from '@connorhoehnslalom/ui-components/shared';
import { runStateChip } from '../../lib/statusTone.ts';
import { relativeTime } from '../../lib/relativeTime.ts';
import { pgTimestampMs } from '../../lib/pgTimestamp.ts';

export type JobStatus = 'queued' | 'claimed' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'cancelled';

// Both thin wrappers over the shared runStateChip (lib/statusTone.ts), the
// work lane's canonical job-status tone map. This used to disagree with it
// on two states: `running` read 'info' (now the louder solid accent tone —
// it's the one state actually in flight right now) and `awaiting_review`
// read 'info' (now 'warning' — it needs someone's attention). Both are
// visible colour changes on this page's job tables.
export function statusLabel(status: JobStatus): string {
  return runStateChip(status).label;
}

export function statusTone(status: JobStatus): ChipTone {
  return runStateChip(status).tone;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return 'never';
  // Parse through pgTimestamp, not `new Date(iso)`: the Data API hands back a
  // NAIVE timestamp and the browser reads that shape as local time, which is
  // how the devbox fleet once showed a machine four hours in the future.
  // `relativeTime` echoes an unparseable string back; this page's tables want
  // an em dash rather than the word "invalid" sitting in a cell.
  if (pgTimestampMs(iso) <= 0 || !Number.isFinite(pgTimestampMs(iso))) return '—';
  return relativeTime(iso);
}

/** Statuses where the job is live right now and the page should keep ticking. */
const LIVE: ReadonlySet<JobStatus> = new Set<JobStatus>(['queued', 'claimed', 'running']);

export function isLive(status: JobStatus): boolean {
  return LIVE.has(status);
}

/**
 * A ticking clock label — `1m 04s`, `12s`, `1h 03m`.
 *
 * Deliberately NOT `durationLabel`: that rounds to one unit ("1m") which is
 * right for a finished thing but reads as frozen when it is meant to be
 * counting. Seconds are zero-padded so the text does not jitter in width
 * while it runs.
 */
export function elapsedLabel(fromIso: string | null | undefined, nowMs: number): string | null {
  const start = pgTimestampMs(fromIso);
  if (!Number.isFinite(start) || start <= 0) return null;
  const secs = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${String(mins % 60).padStart(2, '0')}m`;
}

export interface LiveProgress {
  /** What the row should say right now. */
  label: string;
  /** True while the job is actually executing, so the row can pulse. */
  active: boolean;
  /** Retry context, when this is not the first attempt. */
  attemptNote: string | null;
}

/**
 * What a job is doing, as a sentence that changes on its own.
 *
 * The three live statuses each answer a different question: queued says how
 * long it has been waiting and where it sits in the lane, claimed says a
 * worker has taken it (the gap before the first token, which used to look
 * like a hang), running counts up from the start. Nothing here invents a
 * percentage — the wire carries no notion of how far through a run is, and a
 * progress bar that fills on a timer would be a lie.
 */
export function liveProgress(
  job: { status: JobStatus; createdAt: string; claimedAt?: string | null; startedAt?: string | null; attempts?: number; maxAttempts?: number },
  nowMs: number,
  lanePosition?: number,
): LiveProgress | null {
  if (!isLive(job.status)) return null;
  const attempts = job.attempts ?? 0;
  const attemptNote = attempts > 1
    ? `attempt ${attempts}${job.maxAttempts ? ` of ${job.maxAttempts}` : ''}`
    : null;
  if (job.status === 'running') {
    const e = elapsedLabel(job.startedAt ?? job.claimedAt ?? job.createdAt, nowMs);
    return { label: e ? `running ${e}` : 'running', active: true, attemptNote };
  }
  if (job.status === 'claimed') {
    const e = elapsedLabel(job.claimedAt ?? job.createdAt, nowMs);
    return { label: e ? `starting ${e}` : 'starting', active: true, attemptNote };
  }
  const e = elapsedLabel(job.createdAt, nowMs);
  const place = lanePosition && lanePosition > 1 ? `${ordinal(lanePosition)} in lane` : 'next in lane';
  return { label: e ? `${place} · waiting ${e}` : place, active: false, attemptNote };
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${n % 10 <= 3 ? suffix : 'th'}`;
}

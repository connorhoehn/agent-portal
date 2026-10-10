// The pure half of `useDistillationChannel` (hooks/useDistillationChannel.ts):
// which REST snapshot each live channel patches, how a gateway message is
// recognised as one of our frames, and how a frame patches the snapshot.
// Channel names and frame shapes are spec §3d:
//   distill:levels  {type:'levels', levels}
//   distill:jobs    {type:'job', job}
//   distill:review  {type:'review', pending, decided}
// Those are the page-facing keys. On the wire each carries the `orgiq:`
// partition (WIRE_CHANNEL) because the /ws gateway admits a channel only
// under the caller's tenant prefix — the middleware's
// lib/distillation-channels.ts holds the same names.
// No React; tested under node:test.

import type { CompactionRun, TierLevel } from './types.ts';

export type DistillationChannel = 'distill:levels' | 'distill:jobs' | 'distill:review';

export const CHANNEL_SNAPSHOT_URL: Record<DistillationChannel, string> = {
  'distill:levels': '/api/distillation/levels',
  'distill:jobs': '/api/distillation/compactions',
  'distill:review': '/api/distillation/review',
};

/** The gateway channel each key is subscribed and pushed on. */
export const WIRE_CHANNEL: Record<DistillationChannel, string> = {
  'distill:levels': 'orgiq:distill:levels',
  'distill:jobs': 'orgiq:distill:jobs',
  'distill:review': 'orgiq:distill:review',
};

export type DistillationFrame =
  | { type: 'levels'; levels: TierLevel[] }
  | { type: 'job'; job: CompactionRun }
  | { type: 'review'; pending: number; decided: number };

const FRAME_FOR: Record<DistillationChannel, DistillationFrame['type']> = {
  'distill:levels': 'levels',
  'distill:jobs': 'job',
  'distill:review': 'review',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asFrame(v: unknown, want: DistillationFrame['type']): DistillationFrame | null {
  if (!isRecord(v) || v.type !== want) return null;
  if (want === 'levels') return Array.isArray(v.levels) ? (v as unknown as DistillationFrame) : null;
  if (want === 'job') return isRecord(v.job) && typeof v.job.id === 'string' ? (v as unknown as DistillationFrame) : null;
  return typeof v.pending === 'number' && typeof v.decided === 'number' ? (v as unknown as DistillationFrame) : null;
}

/**
 * Our frame out of a gateway message, or null. The router may deliver the
 * frame bare (`{type:'levels', channel, levels}`) or wrapped
 * (`{type:'message', channel, payload|data|message: {type:'levels', …}}`);
 * both are accepted. A message naming a different channel is never ours.
 */
export function extractFrame(msg: unknown, channel: DistillationChannel): DistillationFrame | null {
  if (!isRecord(msg)) return null;
  if (typeof msg.channel === 'string' && msg.channel !== WIRE_CHANNEL[channel]) return null;
  const want = FRAME_FOR[channel];
  const direct = asFrame(msg, want);
  if (direct) return direct;
  for (const key of ['payload', 'data', 'message'] as const) {
    const inner = asFrame(msg[key], want);
    if (inner) return inner;
  }
  return null;
}

export interface FrameResult<T> {
  next: T;
  /** The frame proved the snapshot stale in a way it cannot patch (a review
   *  count moved, so the sample list did) — refetch the REST snapshot. */
  refetch: boolean;
}

/**
 * Patch a REST snapshot with one frame. The snapshot is the body of
 * CHANNEL_SNAPSHOT_URL[channel]; unknown fields pass through untouched.
 *   levels → replaces `levels` (the frame is the whole ladder)
 *   job    → upserts into `jobs` by id; a new job goes first (newest-first)
 *   review → records `counts` and asks for a refetch when they differ from
 *            what the snapshot's own samples say
 */
export function applyFrame<T>(snapshot: T, frame: DistillationFrame): FrameResult<T> {
  const snap = (isRecord(snapshot) ? snapshot : {}) as Record<string, unknown>;
  switch (frame.type) {
    case 'levels':
      return { next: { ...snap, levels: frame.levels } as T, refetch: false };
    case 'job': {
      const jobs = Array.isArray(snap.jobs) ? (snap.jobs as CompactionRun[]) : [];
      const idx = jobs.findIndex((j) => j.id === frame.job.id);
      const nextJobs = idx === -1
        ? [frame.job, ...jobs]
        : jobs.map((j, i) => (i === idx ? { ...j, ...frame.job } : j));
      return { next: { ...snap, jobs: nextJobs } as T, refetch: false };
    }
    case 'review': {
      const samples = Array.isArray(snap.samples) ? (snap.samples as Array<{ verdict?: string }>) : null;
      const pending = samples ? samples.filter((s) => s.verdict === 'pending').length : null;
      const decided = samples && pending != null ? samples.length - pending : null;
      const stale = pending !== frame.pending || decided !== frame.decided;
      return {
        next: { ...snap, counts: { pending: frame.pending, decided: frame.decided } } as T,
        refetch: samples !== null && stale,
      };
    }
  }
}

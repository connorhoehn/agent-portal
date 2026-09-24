// What changed in the distillation store, announced in process.
//
// The provider says THAT something changed; it never formats a frame or knows
// a socket exists. lib/distillation-realtime.ts listens and turns each signal
// into a channel push, re-reading the provider for the payload so a frame is
// always the same shape the REST route returns — never a second serializer
// that could drift from it. The replica (lib/distillation-replica.ts) listens
// too, to sync when L2 changes rather than only on its interval.

import { EventEmitter } from 'node:events';

export interface DistillationEventMap {
  /** Tier contents changed: an L0 write, a pass writing L1/L2, a publish. */
  levels: [];
  /** A job moved: queued, claimed, a phase step, finished. */
  job: [jobId: string];
  /** A review sample was added or decided. */
  review: [];
  /** L2 rows changed (a pass minted artifacts, a publish) — replica trigger. */
  artifacts: [];
}

class DistillationEvents extends EventEmitter<DistillationEventMap> {}

export const distillationEvents = new DistillationEvents();
// Every open socket's publisher and the replica listen here; a listener cap
// warning would be noise, not a leak signal.
distillationEvents.setMaxListeners(0);

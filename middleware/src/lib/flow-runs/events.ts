// Every durable state move of a flow run, told to whoever listens (the BFF
// gateway's run feed, lib/gateway-run-feed.ts). The store emits AFTER its
// fenced write succeeded, so a frame never announces a move the record does
// not hold; a listener's failure never reaches the store's caller.

import type { FlowRunStep } from '../../mock/flow-runs.js';

export type FlowRunMoveKind = 'claimed' | 'progress' | 'waiting' | 'completed' | 'failed';

export interface FlowRunMove {
  runId: string;
  kind: FlowRunMoveKind;
  /** The progress the record now holds, when the write carried it. */
  steps?: FlowRunStep[];
  /** A failed run's public reason (the same text the REST read returns). */
  error?: string | null;
}

type Listener = (move: FlowRunMove) => void | Promise<void>;
const listeners = new Set<Listener>();

/** Returns the unsubscribe. */
export function onFlowRunMove(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitFlowRunMove(move: FlowRunMove): void {
  for (const listener of listeners) {
    try {
      void Promise.resolve(listener(move)).catch(err => console.warn(`[flow-runs] move listener failed: ${(err as Error).message}`));
    } catch (err) { console.warn(`[flow-runs] move listener failed: ${(err as Error).message}`); }
  }
}

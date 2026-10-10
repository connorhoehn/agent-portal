export interface PipelineQueue {
  name: string; purpose: string; deadLetter: boolean; redriveTo: string | null; maxReceives: number | null;
  state: 'available' | 'missing' | 'unavailable'; reason: string | null;
  snapshot: { ready: number | null; inFlight: number | null; delayed: number | null; fifo: boolean | null; visibilityTimeoutSeconds: number | null } | null;
}
export interface PipelineQueuesResponse { observedAt: string; backend: 'memory' | 'http'; queues: PipelineQueue[] }

/** A partial read cannot look like an empty or healthy fleet. */
export function queueTotal(rows: PipelineQueue[], field: 'ready' | 'inFlight' | 'delayed'): number | null {
  if (!rows.length || rows.some(row => row.state !== 'available' || row.snapshot?.[field] == null)) return null;
  return rows.reduce((sum, row) => sum + row.snapshot![field]!, 0);
}

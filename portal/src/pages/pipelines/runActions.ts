// What a run's detail page may offer on it (lane E). Pure, so node --test
// covers it: Cancel is offered only for a run that has not finished — the
// middleware's TERMINAL set (lib/pipeline-definitions.ts `isTerminalRunStatus`).

const TERMINAL = new Set(['completed', 'rejected', 'failed', 'cancelled']);

/** A run that has finished one way or another — nothing left to cancel. */
export function isTerminalRun(status: string): boolean {
  return TERMINAL.has(status);
}

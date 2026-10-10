// The one answer both tenants' work-graph routes give (routes/work-graph.ts,
// routes/pipelines-work-graph.ts): the viewer's snapshot, or the reference's
// uniform unavailable body — the same 404 whatever the reason.

import type { Response } from 'express';
import { rememberServedWorkGraph, type BuiltWorkGraph } from './build.js';

export const WORK_GRAPH_UNAVAILABLE = { error: 'WORK_GRAPH_UNAVAILABLE', message: 'This work item is unavailable.' } as const;

export function respondWithWorkGraph(res: Response, built: BuiltWorkGraph | null): void {
  if (!built) { res.status(404).set('Cache-Control', 'no-store').json(WORK_GRAPH_UNAVAILABLE); return; }
  // The live stream's catch-up starts from exactly this viewer's snapshot.
  rememberServedWorkGraph(built.viewer.session.sub, built.snapshot);
  res.set('Cache-Control', 'no-store').json(built.snapshot);
}

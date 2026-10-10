// /api/work-graph — the orgiq activity/work graph (docs/activity-graph-migration.md).
//
// The snapshot realtime-modules' `useWorkGraph` fetches, for one calendar day
// in the viewer's zone, scoped to one initiative or to the whole workspace.
// Mounted in index.ts under requireTenant('orgiq'); every part is re-decided
// per request against the reloaded session (lib/work-graph/authority.ts), with
// the read gates of the REST routes that serve each entity.
//
//   GET /initiatives/:id/graph?day&timezone[&schemaVersion=2&windowStart&windowEnd&mode]
//   GET /people/:id/graph?day&timezone[...]   one person's day (assignee, steward, participant; own flow runs)
//   GET /workspace/graph?day&timezone[&schemaVersion=2&windowStart&windowEnd&mode]
//
// A missing initiative answers the reference's uniform unavailable body
// (`WORK_GRAPH_UNAVAILABLE`, 404), the same body whatever the reason.
// Live updates ride the gateway's workGraph() stream (lib/work-graph/stream.ts):
// per-viewer deltas computed by this same builder. The content-free hint on the
// `orgiq:workgraph` activity channel (lib/work-graph/live.ts) remains the
// fallback for a reader whose stream is refused.

import { Router, type Request, type Response } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import type { WorkGraphSubject } from '../lib/work-graph/sources.js';
import { parseWorkGraphQuery } from '../lib/work-graph/snapshot.js';
import { buildViewerWorkGraph } from '../lib/work-graph/build.js';
import { respondWithWorkGraph } from '../lib/work-graph/respond.js';
import '../lib/work-graph/live.js';

export const workGraphRouter = Router();

const INITIATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

async function serve(req: Request, res: Response, subject: WorkGraphSubject): Promise<void> {
  const query = parseWorkGraphQuery(req.query as Record<string, unknown>);
  respondWithWorkGraph(res, await buildViewerWorkGraph(req.session, subject, query));
}

workGraphRouter.get('/initiatives/:id/graph', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!INITIATIVE_ID.test(id)) throw new ValidationError('Invalid initiative id');
  await serve(req, res, { kind: 'initiative', id });
}));

workGraphRouter.get('/people/:id/graph', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!INITIATIVE_ID.test(id)) throw new ValidationError('Invalid person id');
  await serve(req, res, { kind: 'person', id });
}));

workGraphRouter.get('/workspace/graph', asyncHandler(async (req, res) => {
  await serve(req, res, { kind: 'workspace' });
}));


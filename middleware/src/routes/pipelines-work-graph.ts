// /api/pipelines/work-graph — the pipelines tenant's activity/work graph
// (docs/activity-graph-migration.md §8).
//
// Mounted by routes/pipelines.ts at /work-graph, behind requireTenant('pipelines'),
// on the SAME snapshot assembly (lib/work-graph/snapshot.ts), builder shape and
// live stream (lib/work-graph/stream.ts) as /api/work-graph:
//
//   GET /runs/:id/graph?day&timezone[&schemaVersion=2&windowStart&windowEnd&mode]   one run's graph (the run page)
//   GET /workspace/graph?day&timezone[...]                                          every run in the day (/pipelines/activity)
//
// Every part follows the gate of the pipelines route that serves its row, decided
// per request from the reloaded session (lib/work-graph/authority.ts
// pipelinesWorkGraphViewer): definitions, runs, steps, decks and your own flow runs
// behind ViewPipelines; approvals only for ApproveStep, so an author is never told
// one exists. A gate that cannot be decided withholds its part and marks the source
// `authorization-unavailable`. A run the viewer cannot read answers the same
// uniform 404 as an absent one. Live updates: `pipelines:workgraph:run:<id>` and
// `pipelines:workgraph:workspace` on the gateway's work-graph stream, with the
// content-free hint on `pipelines:workgraph` as the fallback (lib/work-graph/live.ts).

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { parseWorkGraphQuery, type PipelinesWorkGraphSubject } from '../lib/work-graph/snapshot.js';
import { buildPipelinesViewerWorkGraph } from '../lib/work-graph/build.js';
import { respondWithWorkGraph } from '../lib/work-graph/respond.js';
import '../lib/work-graph/live.js';

export const pipelinesWorkGraphRouter = Router();

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

pipelinesWorkGraphRouter.get('/runs/:id/graph', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!RUN_ID.test(id)) throw new ValidationError('Invalid run id');
  const subject: PipelinesWorkGraphSubject = { kind: 'run', id };
  respondWithWorkGraph(res, await buildPipelinesViewerWorkGraph(req.session, subject, parseWorkGraphQuery(req.query as Record<string, unknown>)));
}));

pipelinesWorkGraphRouter.get('/workspace/graph', asyncHandler(async (req, res) => {
  const subject: PipelinesWorkGraphSubject = { kind: 'workspace' };
  respondWithWorkGraph(res, await buildPipelinesViewerWorkGraph(req.session, subject, parseWorkGraphQuery(req.query as Record<string, unknown>)));
}));

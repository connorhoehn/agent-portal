// /api/assessment/work-graph — the assessment tenant's activity/work graph
// (docs/activity-graph-migration.md §9).
//
// Mounted by routes/assessment.ts at /work-graph, behind requireTenant('assessment'),
// on the SAME snapshot assembly (lib/work-graph/snapshot.ts), builder shape and
// live stream (lib/work-graph/stream.ts) as orgiq's and pipelines':
//
//   GET /teams/:id/graph?day&timezone[&schemaVersion=2&windowStart&windowEnd&mode]   one team's graph (the scorecard)
//   GET /workspace/graph?day&timezone[...]                                           every team with work in the day (/assessment/activity)
//
// Every part follows the gate of the assessment route that serves its row, decided per request
// from the reloaded session (lib/work-graph/authority.ts assessmentWorkGraphViewer): teams,
// dimensions, evidence, drafts, decks and agent runs behind ViewAssessment (the GETs under
// /api/assessment), the viewer's own flow runs behind RunAssessmentAgent. A gate that cannot be
// decided withholds its part and marks the source `authorization-unavailable`. A team the viewer
// cannot read answers the same uniform 404 as an absent one. Live updates:
// `assessment:workgraph:team:<id>` and `assessment:workgraph:workspace` on the gateway's work-graph
// stream, with the content-free hint on `assessment:workgraph` as the fallback.
//
// `changeHints()` (below) is the one place the assessment REST writes tell the graph something moved:
// a 2xx non-GET on a score, evidence, draft, deck or run path publishes a content-free hint.

import { Router, type RequestHandler } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { parseWorkGraphQuery, type AssessmentWorkGraphSubject } from '../lib/work-graph/snapshot.js';
import { buildAssessmentViewerWorkGraph } from '../lib/work-graph/build.js';
import { respondWithWorkGraph } from '../lib/work-graph/respond.js';
import { notifyAssessmentWorkGraphChanged, type AssessmentWorkGraphCause } from '../lib/work-graph/live.js';
import { isValidTeamId } from '../providers/assessment.js';

export const assessmentWorkGraphRouter = Router();

assessmentWorkGraphRouter.get('/teams/:id/graph', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  if (!isValidTeamId(id)) throw new ValidationError('team id must match ^TEAM-[A-Za-z0-9-]+$');
  const subject: AssessmentWorkGraphSubject = { kind: 'team', id };
  respondWithWorkGraph(res, await buildAssessmentViewerWorkGraph(req.session, subject, parseWorkGraphQuery(req.query as Record<string, unknown>)));
}));

assessmentWorkGraphRouter.get('/workspace/graph', asyncHandler(async (req, res) => {
  const subject: AssessmentWorkGraphSubject = { kind: 'workspace' };
  respondWithWorkGraph(res, await buildAssessmentViewerWorkGraph(req.session, subject, parseWorkGraphQuery(req.query as Record<string, unknown>)));
}));

/** The cause a write path moves, and the team it names (when the path does). Null: the path moves nothing the graph draws. */
export function changeFor(method: string, path: string): { cause: AssessmentWorkGraphCause; teamId: string | null } | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  const team = /^\/teams\/(TEAM-[A-Za-z0-9-]+)(\/.*)?$/i.exec(path);
  const teamId = team?.[1] ?? null;
  const rest = team?.[2] ?? '';
  if (/^\/teams\/[^/]+\/dimensions\/[^/]+\/drafts\//i.test(path) || /^\/drafts\//i.test(path)) return { cause: 'draft', teamId };
  if (/^\/teams\/[^/]+\/decks\/?$/i.test(path) || /^\/decks(\/|$)/i.test(path)) return { cause: 'deck', teamId };
  if (team && /^\/(evidence|intake\/)/i.test(rest)) return { cause: 'evidence', teamId };
  if (/^\/submissions\//i.test(path)) return { cause: 'evidence', teamId: null };
  if (team) return { cause: 'score', teamId };
  if (/^\/teams\/?$/i.test(path) || /^\/feedback(\/|$)/i.test(path)) return { cause: 'score', teamId: null };
  if (/^\/runs(\/|$)/i.test(path)) return { cause: 'run', teamId: null };
  return null;
}

/** Hints the graph after any successful assessment write (fire-and-forget; the stream re-decides per viewer). */
export function changeHints(): RequestHandler {
  return (req, res, next) => {
    const change = changeFor(req.method, req.path);
    if (change) {
      res.on('finish', () => {
        if (res.statusCode < 400) void notifyAssessmentWorkGraphChanged(change.teamId, change.cause).catch(() => undefined);
      });
    }
    next();
  };
}

// /api/social/work-graph — the social tenant's activity/work graph (docs/activity-graph-migration.md §10).
//
// Mounted by routes/social.ts at /work-graph, behind requireTenant('social') (index.ts), on the SAME snapshot
// assembly (lib/work-graph/snapshot.ts), builder shape and live stream (lib/work-graph/stream.ts) as orgiq,
// pipelines and assessment:
//
//   GET /conversations/:id/graph?day&timezone[&schemaVersion=2&windowStart&windowEnd&mode]   one conversation (the chat workspace's Graph view)
//   GET /workspace/graph?day&timezone[...]                                                  every conversation of the viewer's with work in the day (/social/work-graph)
//
// `:id` is the conversation's chat channel name, URL-encoded (`social:ch:<slug>`, `social:dm:<a>:<b>`,
// `social:team:<team>:<channel>`, `social:room:<slug>`). Every part follows the authority of the route that serves
// its row, decided per request from the reloaded session (lib/work-graph/authority.ts socialWorkGraphViewer):
// ViewSocial for everything, and a conversation is read only after the viewer is shown to belong to it NOW — the
// membership authority the chat uses (lib/work-graph/social-sources.ts). A conversation the viewer does not belong
// to answers the same uniform 404 as an absent or malformed one, so a private channel's existence is not disclosed.
// A gate that cannot be decided withholds its part and marks the source `authorization-unavailable`. Live updates:
// `social:workgraph:conversation:<id>` and `social:workgraph:workspace` on the gateway's work-graph stream, with the
// content-free hint on `social:workgraph` as the fallback.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { parseWorkGraphQuery, type SocialWorkGraphSubject } from '../lib/work-graph/snapshot.js';
import { buildSocialViewerWorkGraph } from '../lib/work-graph/build.js';
import { respondWithWorkGraph, WORK_GRAPH_UNAVAILABLE } from '../lib/work-graph/respond.js';
import { SOCIAL_CONVERSATION_ID } from '../lib/tenant-channels.js';
import '../lib/work-graph/live.js';

export const socialWorkGraphRouter = Router();

socialWorkGraphRouter.get('/conversations/:id/graph', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  // A malformed name is the same answer as a conversation the viewer cannot read.
  if (!SOCIAL_CONVERSATION_ID.test(id)) { res.status(404).set('Cache-Control', 'no-store').json(WORK_GRAPH_UNAVAILABLE); return; }
  const subject: SocialWorkGraphSubject = { kind: 'conversation', id };
  respondWithWorkGraph(res, await buildSocialViewerWorkGraph(req.session, subject, parseWorkGraphQuery(req.query as Record<string, unknown>)));
}));

socialWorkGraphRouter.get('/workspace/graph', asyncHandler(async (req, res) => {
  const subject: SocialWorkGraphSubject = { kind: 'workspace' };
  respondWithWorkGraph(res, await buildSocialViewerWorkGraph(req.session, subject, parseWorkGraphQuery(req.query as Record<string, unknown>)));
}));

// The org graph's decision layer over HTTP — `decisions` + `decision_participants`.
//
// ⚠️ NO CONSUMER, DELIBERATELY KEPT. Nothing in portal/, agents/ or docs/ calls
// these routes: portal/src/App.tsx redirects `/decisions` and `/decisions/:id`
// to `/iq/projects`, and `/iq/explore?entities=decisions` labels a filter
// "Decisions" but narrows to `mentors | reports_to` edges (ExplorePage.tsx) —
// `/api/graph/entities` returns no decision nodes at all.
//
// So this is still the API half of a page that does not exist. What it is NOT
// any more is a different subject from the one the product already renders.
// `decisions` is ONE table with one concept (see the comment on it in
// schema/orgiq_schema.sql): a call the org has made or still has to make,
// optionally raised against an initiative. This route serves all of them; an
// initiative's Decisions tab (`GET /api/graph/projects/:id/decisions`,
// providers/work-items.ts) serves the same rows filtered by `project_id`. They
// used to be disjoint — the seeded ADRs carried no project_id, so no initiative
// could reach them, and the program decisions carried no decided_at or
// participants, so this list could not date them or say who decided. Both
// seeds now fill the whole column set, both reads report `status` and
// `projectId`, and mock/core/parity/invariants.ts fails if they drift apart
// again ("the two decision surfaces read one table").
//
// It stays unmounted-in-the-portal because the missing half is a page, and
// deleting the working half would not bring one closer. Its wire shape is
// pinned by routes/__tests__/graph-decisions-route.test.ts so it cannot rot
// while it waits. (README.md still lists `/decisions` as a portal page; that
// row is stale.)

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { listDecisions, getDecision } from '../providers/decisions.js';

export const decisionsRouter = Router();

// GET /api/graph/decisions?limit=N&since=ISO
decisionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rawLimit = parseInt(req.query['limit'] as string ?? '50', 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
    const since = req.query['since'] as string | undefined;

    const decisions = await listDecisions({ limit, since });
    res.json(decisions);
  }),
);

// GET /api/graph/decisions/:id
decisionsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] as string;
    const decision = await getDecision(id);
    if (!decision) {
      res.status(404).json({ error: 'Decision not found' });
      return;
    }
    res.json(decision);
  }),
);

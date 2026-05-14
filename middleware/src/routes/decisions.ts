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

// newsroom-beats route — beat coverage heatmap endpoints.
// Mounted at /api/newsroom/beats in index.ts, BEFORE the /api/newsroom
// catch-all so the beats path isn't swallowed.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { getBeatCoverage, getTopBeats } from '../providers/newsroom-beats.js';

export const newsroomBeatsRouter = Router();

// GET /api/newsroom/beats/coverage?days=14
newsroomBeatsRouter.get('/coverage', asyncHandler(async (req, res) => {
  const rawDays = parseInt(req.query['days'] as string ?? '14', 10);
  const days = Number.isFinite(rawDays) ? Math.min(90, Math.max(1, rawDays)) : 14;
  const data = await getBeatCoverage({ days });
  res.json(data);
}));

// GET /api/newsroom/beats/top?limit=5
newsroomBeatsRouter.get('/top', asyncHandler(async (req, res) => {
  const rawLimit = parseInt(req.query['limit'] as string ?? '5', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 5;
  const data = await getTopBeats(limit);
  res.json(data);
}));

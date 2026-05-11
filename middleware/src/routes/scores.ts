import { Router } from 'express';
import { aurora } from '../providers/index.js';
import { asyncHandler } from '../lib/async-handler.js';

export const scoresRouter = Router();

scoresRouter.get('/leaderboard', asyncHandler(async (req, res) => {
  const department = req.query['department'] as string | undefined;
  const limit = parseInt(req.query['limit'] as string ?? '12', 10);

  const result = await aurora.getLeaderboard({ department, limit });
  res.json(result);
}));

scoresRouter.get('/:personId', asyncHandler(async (req, res) => {
  const score = await aurora.getScore(req.params['personId'] as string);
  if (!score) { res.status(404).json({ error: 'Score not found' }); return; }
  res.json(score);
}));

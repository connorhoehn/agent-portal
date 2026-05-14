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

scoresRouter.get('/skills', asyncHandler(async (req, res) => {
  const limit = req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 30;
  const result = await aurora.getTopSkills(limit);
  res.json(result);
}));

scoresRouter.get('/by-skill', asyncHandler(async (req, res) => {
  const skill = req.query['skill'] as string | undefined;
  if (!skill) {
    res.status(400).json({ error: '`skill` query param is required' });
    return;
  }
  const limit = req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 25;
  const result = await aurora.getSkillLeaderboard({ skill, limit });
  res.json(result);
}));

scoresRouter.get('/cohorts', asyncHandler(async (_req, res) => {
  const cohorts = await aurora.getCohorts();
  res.json(cohorts);
}));

scoresRouter.get('/:personId', asyncHandler(async (req, res) => {
  const score = await aurora.getScore(req.params['personId'] as string);
  if (!score) { res.status(404).json({ error: 'Score not found' }); return; }
  res.json(score);
}));

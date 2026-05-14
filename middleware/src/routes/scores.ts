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

// Batch radar endpoint — must be mounted BEFORE /:personId routes to avoid path ambiguity.
scoresRouter.get('/radar', asyncHandler(async (req, res) => {
  const idsParam = req.query['ids'] as string | undefined;
  if (!idsParam || idsParam.trim() === '') {
    res.status(400).json({ error: '`ids` query param is required (CSV, 2-4 person IDs)' });
    return;
  }
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length < 1 || ids.length > 4) {
    res.status(400).json({ error: '`ids` must contain between 1 and 4 person IDs' });
    return;
  }
  const results = await aurora.getRadarBatch(ids);
  res.json(results);
}));

scoresRouter.get('/:personId/radar', asyncHandler(async (req, res) => {
  const radar = await aurora.getPersonRadar(req.params['personId'] as string);
  if (!radar) { res.status(404).json({ error: 'Person not found or not scored' }); return; }
  res.json(radar);
}));

scoresRouter.get('/:personId', asyncHandler(async (req, res) => {
  const score = await aurora.getScore(req.params['personId'] as string);
  if (!score) { res.status(404).json({ error: 'Score not found' }); return; }
  res.json(score);
}));

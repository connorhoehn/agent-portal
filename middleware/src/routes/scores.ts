import { Router } from 'express';
import { aurora } from '../providers/index.js';
import { getPersonHistory } from '../providers/scores-history.js';
import { asyncHandler } from '../lib/async-handler.js';
import { analyzeScores } from '../lib/score-analysis.js';

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

scoresRouter.get('/:personId/contributions', asyncHandler(async (req, res) => {
  const result = await aurora.getContributions(req.params['personId'] as string);
  if (!result) { res.status(404).json({ error: 'Person not found or no contribution data' }); return; }
  res.json(result);
}));

scoresRouter.get('/:personId/history', asyncHandler(async (req, res) => {
  const personId = req.params['personId'] as string;
  const rawDays = parseInt(req.query['days'] as string ?? '30', 10);
  const days = Number.isNaN(rawDays) ? 30 : Math.min(Math.max(rawDays, 1), 90);
  try {
    const history = await getPersonHistory(personId, days);
    res.json(history);
  } catch {
    // Missing table, no creds — return empty so the UI handles it gracefully.
    res.json({ personId, samples: [], deltaVs7d: null });
  }
}));

scoresRouter.get('/:personId', asyncHandler(async (req, res) => {
  const score = await aurora.getScore(req.params['personId'] as string);
  if (!score) { res.status(404).json({ error: 'Score not found' }); return; }
  res.json(score);
}));

// ── POST /analysis — real arithmetic over the score columns ─────────────────
//
// The three score columns are rendered as-is everywhere else, which supports
// exactly two questions: who is highest, and what is the number. This fits the
// composite against its own inputs so the page can say what the score is
// actually weighting and where it disagrees with the evidence.
//
// POST because it costs a Code Interpreter session and takes seconds — it is
// an action someone chooses, not something a page load triggers.
scoresRouter.post('/analysis', asyncHandler(async (_req, res) => {
  try {
    res.json(await analyzeScores());
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
  }
}));

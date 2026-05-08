import { Router } from 'express';
import { mockScores } from '../mock/scores.js';

export const scoresRouter = Router();

scoresRouter.get('/leaderboard', (req, res) => {
  const dept = req.query['department'] as string | undefined;
  const limit = parseInt(req.query['limit'] as string ?? '12', 10);

  let entries = mockScores;
  if (dept) {
    entries = entries.filter(s => s.department.toLowerCase().includes(dept.toLowerCase()));
  }

  res.json({
    entries: entries.slice(0, limit),
    total: entries.length,
  });
});

scoresRouter.get('/:personId', (req, res) => {
  const score = mockScores.find(s => s.personId === req.params['personId']);
  if (!score) { res.status(404).json({ error: 'Score not found' }); return; }
  res.json(score);
});

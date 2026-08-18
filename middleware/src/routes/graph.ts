import { Router } from 'express';
import { aurora } from '../providers/index.js';
import { asyncHandler } from '../lib/async-handler.js';

export const graphRouter = Router();

graphRouter.get('/entities', asyncHandler(async (_req, res) => {
  const snapshot = await aurora.fetchGraph();
  res.json(snapshot);
}));

graphRouter.get('/skills-graph', asyncHandler(async (_req, res) => {
  const snapshot = await aurora.fetchSkillsGraph();
  res.json(snapshot);
}));

graphRouter.get('/projects-graph', asyncHandler(async (_req, res) => {
  const snapshot = await aurora.fetchProjectsGraph();
  res.json(snapshot);
}));

graphRouter.get('/people/:personId', asyncHandler(async (req, res) => {
  const personId = req.params['personId'];
  const detail = typeof personId === 'string' ? await aurora.fetchPersonGraph(personId) : null;
  if (!detail) { res.status(404).json({ error: 'Person not found' }); return; }
  res.json(detail);
}));

// Documents that mention this person — the evidence behind skills/scores.
// Empty array (not 404) when the corpus hasn't been ingested yet.
graphRouter.get('/people/:personId/evidence', asyncHandler(async (req, res) => {
  const personId = req.params['personId'];
  const docs = typeof personId === 'string' ? await aurora.fetchPersonEvidence(personId) : [];
  res.json({ documents: docs });
}));

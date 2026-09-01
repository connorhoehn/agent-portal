import { Router } from 'express';
import { aurora } from '../providers/index.js';
import { asyncHandler } from '../lib/async-handler.js';
import { findHelp } from '../lib/help-search.js';

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

// Who can help with a domain — the SME-tier lookup. Evidence-ranked and
// score-free on purpose: this router's ViewOrgChart gate is held by every
// orgiq role, unlike /api/scores' ViewLeaderboard, so nothing here may leak
// the analytics view. Docs are fetched only for the people actually returned.
graphRouter.get('/help', asyncHandler(async (req, res) => {
  const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
  if (!q) {
    res.status(400).json({ error: '`q` query param is required' });
    return;
  }
  const [graph, skillsGraph, projectsGraph] = await Promise.all([
    aurora.fetchGraph(),
    aurora.fetchSkillsGraph(),
    aurora.fetchProjectsGraph(),
  ]);
  const matches = findHelp(q, { graph, skillsGraph, projectsGraph });
  const people = await Promise.all(matches.map(async (m) => ({
    ...m,
    documents: (await aurora.fetchPersonEvidence(m.id)).slice(0, 3),
  })));
  res.json({ query: q, people });
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

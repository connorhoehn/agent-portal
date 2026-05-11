import { Router } from 'express';
import { aurora } from '../providers/index.js';
import { asyncHandler } from '../lib/async-handler.js';

export const graphRouter = Router();

graphRouter.get('/entities', asyncHandler(async (_req, res) => {
  const snapshot = await aurora.fetchGraph();
  res.json(snapshot);
}));

graphRouter.get('/people/:personId', asyncHandler(async (req, res) => {
  const personId = req.params['personId'];
  const detail = typeof personId === 'string' ? await aurora.fetchPersonGraph(personId) : null;
  if (!detail) { res.status(404).json({ error: 'Person not found' }); return; }
  res.json(detail);
}));

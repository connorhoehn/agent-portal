import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { listSessions, listEvents } from '../providers/memory.js';

export const sessionsRouter = Router();

sessionsRouter.get('/', asyncHandler(async (req, res) => {
  const actorId = (req.query['actorId'] as string) || undefined;
  const sessions = await listSessions(actorId);
  res.json({ sessions });
}));

sessionsRouter.get('/:sessionId/events', asyncHandler(async (req, res) => {
  const sessionId = String(req.params['sessionId'] ?? '');
  const actorId = (req.query['actorId'] as string) || undefined;
  const events = await listEvents(sessionId, actorId);
  res.json({ events });
}));

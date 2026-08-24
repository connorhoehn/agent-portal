import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { listSessions, listEvents } from '../providers/memory.js';
import { getSessionTitle, maybeGenerateTitle } from '../lib/session-titles.js';

export const sessionsRouter = Router();

sessionsRouter.get('/', asyncHandler(async (req, res) => {
  const actorId = (req.query['actorId'] as string) || undefined;
  const sessions = await listSessions(actorId);
  // Backfill titles for any sessions that don't have one yet: pull the first
  // user message from the session's events and kick off generation in the
  // background. The title will appear on a subsequent poll.
  const enriched = await Promise.all(sessions.map(async (s) => {
    const cached = getSessionTitle(s.sessionId);
    if (cached) return { ...s, title: cached };
    // Fire backfill async so we don't slow the response.
    void (async () => {
      try {
        const evs = await listEvents(s.sessionId, actorId);
        const firstUser = evs.find((e) => e.role === 'USER');
        if (firstUser?.text) maybeGenerateTitle(s.sessionId, firstUser.text);
      } catch {}
    })();
    return { ...s, title: '' };
  }));
  res.json({ sessions: enriched });
}));

// The stored transcript for one conversation.
//
// Each ASSISTANT event carries `toolCalls` when the turn was recorded with
// them (see providers/memory + lib/turn-tool-calls) — that is the provenance
// the portal turns back into source chips and the "searched knowledge base ×3"
// line. Turns written before tool-call persistence simply have no `toolCalls`
// key and restore as text, exactly as they did.
sessionsRouter.get('/:sessionId/events', asyncHandler(async (req, res) => {
  const sessionId = String(req.params['sessionId'] ?? '');
  const actorId = (req.query['actorId'] as string) || undefined;
  const events = await listEvents(sessionId, actorId);
  res.json({ events });
}));

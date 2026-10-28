import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { listSessions, listEvents, memoryConfigured } from '../providers/memory.js';
import { memoryActor } from '../lib/memory-actor.js';
import {
  getSessionTitle,
  beginBackfill,
  generateTitleReserved,
  markUntitleable,
  releaseBackfill,
} from '../lib/session-titles.js';

export const sessionsRouter = Router();

// The actor is the signed-in user (memoryActor), never a query parameter: an
// `?actorId=` used to list and read any other user's conversations.
sessionsRouter.get('/', asyncHandler(async (req, res) => {
  const actorId = memoryActor(req.session);
  if (!actorId) { res.status(401).json({ error: 'sign in to read your conversations' }); return; }
  const sessions = await listSessions(actorId);
  // Backfill titles for any sessions that don't have one yet: pull the first
  // user message from the session's events and kick off generation in the
  // background. The title will appear on a subsequent poll.
  const enriched = await Promise.all(sessions.map(async (s) => {
    const cached = getSessionTitle(s.sessionId);
    if (cached) return { ...s, title: cached };
    // Reserve the attempt BEFORE reading events. A session that's already
    // titled, in-flight, or negative-cached as untitleable (no USER message /
    // blank generation) returns false here, so we issue no read and no Nova
    // call on subsequent polls — the settled cases used to re-query forever.
    if (beginBackfill(s.sessionId)) {
      // Fire backfill async so we don't slow the response.
      void (async () => {
        try {
          const evs = await listEvents(s.sessionId, actorId);
          const firstUser = evs.find((e) => e.role === 'USER');
          if (firstUser?.text) generateTitleReserved(s.sessionId, firstUser.text);
          else markUntitleable(s.sessionId); // no USER message → never titleable
        } catch {
          releaseBackfill(s.sessionId); // transient read failure → retry later
        }
      })();
    }
    return { ...s, title: '' };
  }));
  // WHY THE LIST CAN BE EMPTY MATTERS HERE. `listSessions` opens with
  // `if (!memoryId) return []` — and `memoryId` is never set under the
  // documented `npm run dev:mock`, because DEV_OFFLINE skips `.env.aws`
  // entirely. So offline this endpoint answered a confident `[]` and the page
  // said "No chat sessions yet. Start a conversation on the Agent Tools page"
  // — an instruction that cannot work, since `recordTurn` short-circuits on
  // the same check and writes nothing.
  //
  // Same shape as the devbox fleet and the ingest crawl surface: a real
  // feature that looks like it simply has no data. CapabilityEventsPage
  // already solved the presentation half of this ("the feed is held in
  // memory... this is not a claim that the capabilities have never run"); the
  // page could not say anything like that here because nothing told it.
  const unconfigured = !memoryConfigured();
  res.json({
    sessions: enriched,
    ...(unconfigured
      ? { memoryUnavailable: 'AgentCore Memory is not configured (MEMORY_ID unset), so no transcript can be read or written' }
      : {}),
  });
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
  const actorId = memoryActor(req.session);
  if (!actorId) { res.status(401).json({ error: 'sign in to read your conversations' }); return; }
  const events = await listEvents(sessionId, actorId);
  res.json({ events });
}));

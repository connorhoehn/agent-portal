// GET /api/discussions/unread — the signed-in user's page discussions with new
// messages in their ACTIVE tenant (orgiq initiative/work threads, assessment
// team/document chats, pipelines run threads), each with its server-computed
// unread count and the rail door it belongs to. The tenant's rail and palette
// draw their badges from this; nothing is counted on the client.
//
// Every thread is re-decided per call (lib/page-thread-unread.ts
// unreadThreadsFor): the session's family read authority, the user's current
// read gate (directory grants, policy, the page's resource row) and the cursor
// the gateway stored for them. The session is re-validated before and after.

import { Router } from 'express';
import { AppError, asyncHandler } from '../lib/async-handler.js';
import { requireSession, resolveSession } from '../lib/authz.js';
import { currentLiveSession } from '../lib/live-principal.js';
import { unreadThreadsFor } from '../lib/page-thread-unread.js';

export const discussionsRouter = Router();

discussionsRouter.get('/unread', requireSession('DiscussionsUnread'), asyncHandler(async (req, res) => {
  const signed = resolveSession(req);
  if (!signed) throw new AppError(401, 'Sign in again.');
  const session = await currentLiveSession(signed);
  let threads;
  try { threads = await unreadThreadsFor(session); } catch { throw new AppError(503, 'Unread discussions are unavailable'); }
  const current = await currentLiveSession(session);
  if (current.tenant !== session.tenant) throw new AppError(401, 'Sign in again.');
  const sections: Record<string, number> = {};
  for (const t of threads) sections[t.section] = (sections[t.section] ?? 0) + 1;
  res.set('Cache-Control', 'no-store');
  res.json({ tenant: session.tenant, threads, sections });
}));

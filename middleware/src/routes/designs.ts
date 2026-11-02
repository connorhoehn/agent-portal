// Design reviews — /api/designs. The Design phase's ADR threads.
//
// Reads are open to the tenant (a design decision is context everyone works
// under). The two writes are the human half of the loop: ANSWERING an agent's
// question and SIGNING OFF a decision — both DispatchAgentRun-tier, the same
// authority that directs agent work, because answering intent and ratifying a
// plan is directing the agents.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import { requireInitiativeScope } from '../lib/initiative-scope.js';
import { getUser } from '../providers/identity.js';
import { userAvatars } from '../providers/user-avatars.js';
import {
  listDesignReviews, getDesignThread, answerQuestion, signoffDesign,
} from '../providers/design-reviews.js';

export const designsRouter: Router = Router();

const steerGate = requireAction('DispatchAgentRun');

async function actorPortrait(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const user = await getUser(userId);
  return (await userAvatars([user ?? { id: userId, personId: null }])).get(userId) ?? null;
}

// GET /api/designs?initiative=&status=
designsRouter.get('/', asyncHandler(async (req, res) => {
  const orgProjectId = String(req.query['initiative'] ?? '').trim();
  const status = String(req.query['status'] ?? '').trim();
  res.json({
    reviews: await listDesignReviews({
      ...(orgProjectId ? { orgProjectId } : {}),
      ...(status ? { status } : {}),
    }),
  });
}));

// GET /api/designs/:id — the full thread + what it gates
designsRouter.get('/:id', asyncHandler(async (req, res) => {
  const thread = await getDesignThread(String(req.params['id'] ?? ''));
  if (!thread) throw new NotFoundError('design review not found');
  res.json(thread);
}));

/** A design review's home initiative decides who may answer or ratify it (DE-44 row 30). */
async function designInScope(req: { session?: import('../lib/session.js').Session | null; params: Record<string, unknown> },
  res: import('express').Response, action: string): Promise<boolean> {
  const thread = await getDesignThread(String(req.params['id'] ?? ''));
  if (!thread) throw new NotFoundError('design review not found');
  return requireInitiativeScope(req, res, thread.orgProjectId, { action });
}

// POST /api/designs/:id/answer {questionPostId, body}
// The human half of the HITL loop: resolve an open agent question. The agent
// follows up with a revision, and the thread advances when nothing is open.
designsRouter.post('/:id/answer', steerGate, asyncHandler(async (req, res) => {
  const { questionPostId, body } = (req.body ?? {}) as { questionPostId?: string; body?: string };
  if (!questionPostId || !String(body ?? '').trim()) {
    throw new ValidationError('questionPostId and a non-empty body are required');
  }
  if (!await designInScope(req, res, 'answer design questions')) return;
  const session = resolveSession(req);
  const thread = await answerQuestion(
    String(req.params['id'] ?? ''), questionPostId, String(body).trim(),
    session?.name ?? session?.sub ?? 'someone',
    await actorPortrait(session?.sub),
  );
  if (!thread) {
    res.status(409).json({ error: 'question not found or already answered' });
    return;
  }
  res.json(thread);
}));

// POST /api/designs/:id/signoff {decision: 'approve'|'reject'}
// Ratify (or refuse) the decision. Approval is refused while questions are
// open, while there is no decision post, or while a design this one depends
// on is not itself approved — the 409 names the blocking review.
designsRouter.post('/:id/signoff', steerGate, asyncHandler(async (req, res) => {
  const { decision } = (req.body ?? {}) as { decision?: string };
  if (decision !== 'approve' && decision !== 'reject') {
    throw new ValidationError("decision must be 'approve' or 'reject'");
  }
  if (!await designInScope(req, res, 'sign off designs')) return;
  const session = resolveSession(req);
  const result = await signoffDesign(
    String(req.params['id'] ?? ''), decision,
    session?.name ?? session?.sub ?? 'someone', session?.role ?? 'member',
    await actorPortrait(session?.sub),
  );
  if (!result) throw new NotFoundError('design review not found');
  if ('error' in result && result.error) {
    res.status(409).json({ error: result.error, ...(result.blockingId ? { blockingId: result.blockingId } : {}) });
    return;
  }
  res.json(result.thread);
}));

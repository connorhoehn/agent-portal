// Rediscovery — /api/rediscovery. Look before you spend.
//
// Reads are open to any signed-in tenant session: knowing that somebody
// already solved this is not privileged, and putting a capability check in
// front of it would defeat the purpose at exactly the moment it matters.
// Recording an outcome is likewise open — it is the caller reporting what they
// did, not an action on someone else's resource.

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { checkRediscovery, recordOutcome, rediscoveryStats } from '../providers/rediscovery.js';

export const rediscoveryRouter: Router = Router();

// POST /check — the pre-flight. Body carries the problem and, when the caller
// knows it, the estimate the spend was about to be authorised against.
rediscoveryRouter.post('/check', asyncHandler(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const problem = typeof b['problem'] === 'string' ? b['problem'].trim() : '';
  if (!problem) throw new ValidationError('problem is required');

  res.json(await checkRediscovery({
    problem,
    repo: typeof b['repo'] === 'string' ? b['repo'] : null,
    initiativeId: typeof b['initiativeId'] === 'string' ? b['initiativeId'] : null,
    workItemId: typeof b['workItemId'] === 'string' ? b['workItemId'] : null,
    estimateUsd: typeof b['estimateUsd'] === 'number' ? b['estimateUsd'] : null,
    estimateMinutes: typeof b['estimateMinutes'] === 'number' ? b['estimateMinutes'] : null,
  }));
}));

// POST /outcome — what the human did with a match. `dismissed` is as valuable
// as `used`: it is how a retrieval bug becomes visible.
rediscoveryRouter.post('/outcome', asyncHandler(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const experienceId = typeof b['experienceId'] === 'string' ? b['experienceId'] : '';
  const action = b['action'];
  if (!experienceId) throw new ValidationError('experienceId is required');
  if (action !== 'used' && action !== 'dismissed') {
    throw new ValidationError("action must be 'used' or 'dismissed'");
  }
  await recordOutcome({
    experienceId,
    workItemId: typeof b['workItemId'] === 'string' ? b['workItemId'] : null,
    action,
    reason: typeof b['reason'] === 'string' ? b['reason'] : null,
    avoidedUsd: typeof b['avoidedUsd'] === 'number' ? b['avoidedUsd'] : null,
    avoidedMinutes: typeof b['avoidedMinutes'] === 'number' ? b['avoidedMinutes'] : null,
  });
  res.json({ ok: true });
}));

// GET /stats — the scoreboard this feature has to earn.
rediscoveryRouter.get('/stats', asyncHandler(async (req, res) => {
  const raw = parseInt(String(req.query['windowDays'] ?? '30'), 10);
  res.json(await rediscoveryStats(Number.isNaN(raw) ? 30 : raw));
}));

// GET /api/me/spend?period=month|7d|30d — what the signed-in person spent, per
// initiative (DE-31 item 5): every ledger entry whose `actor_id` is them — the
// sender of a task on a shared box, the dispatcher of a run, the creator of a
// job — never the box owner by inference. `initiativeId: null` is their
// unattributed spend. Read-only; mounted in index.ts under a session floor.
//
// "Me" is the session subject, never a query field (`?actorId=` is ignored),
// so the read is exactly as wide as the caller. A masquerade reads the
// impersonated account, like /api/me/groups.

import { Router } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { resolveSession } from '../lib/authz.js';
import { getActorSpend, periodStartIso, type SpendPeriod } from '../providers/spend-ledger.js';

export const meSpendRouter = Router();

const PERIODS: readonly SpendPeriod[] = ['month', '7d', '30d'];

meSpendRouter.get('/', asyncHandler(async (req, res) => {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Unauthenticated');
  const raw = req.query['period'];
  const period = (raw == null || raw === '' ? 'month' : String(raw)) as SpendPeriod;
  if (!PERIODS.includes(period)) throw new ValidationError(`period must be one of ${PERIODS.join(', ')}`);
  const rows = await getActorSpend(session.sub, period);
  res.set('Cache-Control', 'no-store');
  res.json({
    actorId: session.sub,
    period,
    since: periodStartIso(period),
    knownUsd: Math.round(rows.reduce((a, r) => a + r.knownUsd, 0) * 10_000) / 10_000,
    unknownCount: rows.reduce((a, r) => a + r.unknownCount, 0),
    byInitiative: rows,
  });
}));

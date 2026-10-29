// User budgets — /api/user-budgets (DE-54, docs/deployment-enhancements/DE-54-user-budgets.md)
//
// A monthly allocation and optional hard cap per app user, enforced on every
// spend path by lib/spend-holds.ts `reserveSpend` (the third lock,
// 'user:'||sub). A user with no row is unbraked; the list shows every user
// who spent this period without one, as the blind spot it is.
//
// Gated like /api/budgets:
//   reads  — org-leader, hr-admin, program-owner, else ManageBudgets.
//   writes — ManageBudgets, and never on your own row (nor, while
//            masquerading, on the real actor's): a user never raises their own.
//            Not initiative-scoped: a user budget spans initiatives.
// A user reads their own budget at GET /api/me/spend (`budget`).

import { Router, type Request } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction, resolveSession } from '../lib/authz.js';
import {
  appUserExists, deleteUserBudget, getUserBudget, listUserBudgetRowsAndSpenders, upsertUserBudget,
  userBudgetView, userSpendThisPeriod,
} from '../providers/user-budgets.js';
import { openHeldUsdForActor, missingHoldsTable } from '../providers/spend-holds.js';

export const userBudgetsRouter: Router = Router();

const readGate = readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], 'ManageBudgets');
const manageGate = requireAction('ManageBudgets');

const NOTE_MAX = 500;

async function heldFor(userId: string): Promise<number> {
  try { return await openHeldUsdForActor(userId); } catch (err) {
    if (missingHoldsTable(err)) return 0;
    throw err;
  }
}

async function viewFor(userId: string) {
  const [row, spend, held] = await Promise.all([getUserBudget(userId), userSpendThisPeriod(userId), heldFor(userId)]);
  return userBudgetView(userId, row, spend, held);
}

/** The caller, or the real identity behind a masquerade, may not set this row. */
function isSelf(req: Request, userId: string): boolean {
  const session = resolveSession(req);
  return session?.sub === userId || session?.act?.sub === userId;
}

function optionalMoney(raw: unknown, name: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new ValidationError(`${name} must be a finite number >= 0, or null`);
  return raw;
}

userBudgetsRouter.get('/', readGate, asyncHandler(async (_req, res) => {
  const { rows, spenders } = await listUserBudgetRowsAndSpenders();
  const ids = [...new Set([...rows.map((r) => r.userId), ...spenders])];
  const budgets = await Promise.all(ids.map(async (id) => {
    const [spend, held] = await Promise.all([userSpendThisPeriod(id), heldFor(id)]);
    return userBudgetView(id, rows.find((r) => r.userId === id) ?? null, spend, held);
  }));
  // Blind spots (spending, no budget) first, then by spend.
  budgets.sort((a, b) => Number(a.allocatedUsd != null) - Number(b.allocatedUsd != null) || b.spentUsd - a.spentUsd || a.userId.localeCompare(b.userId));
  res.set('Cache-Control', 'no-store');
  res.json({ budgets });
}));

userBudgetsRouter.get('/:userId', readGate, asyncHandler(async (req, res) => {
  const userId = String(req.params['userId'] ?? '').trim();
  if (!userId) throw new ValidationError('userId is required');
  res.set('Cache-Control', 'no-store');
  res.json({ budget: await viewFor(userId) });
}));

//   PUT /api/user-budgets/:userId { allocatedUsd, hardCapUsd?, note? } → { budget }
userBudgetsRouter.put('/:userId', manageGate, asyncHandler(async (req, res) => {
  const userId = String(req.params['userId'] ?? '').trim();
  if (!userId) throw new ValidationError('userId is required');
  if (isSelf(req, userId)) {
    res.status(403).json({ error: 'A user never sets their own budget; ask another budget holder.', gate: 'self-budget' });
    return;
  }
  const body = (req.body ?? {}) as { allocatedUsd?: unknown; hardCapUsd?: unknown; note?: unknown };
  const allocatedUsd = typeof body.allocatedUsd === 'number' ? body.allocatedUsd : NaN;
  if (!Number.isFinite(allocatedUsd) || allocatedUsd < 0) throw new ValidationError('allocatedUsd must be a finite number >= 0');
  const hardCapUsd = optionalMoney(body.hardCapUsd, 'hardCapUsd');
  let note: string | null | undefined;
  if (body.note !== undefined) {
    if (body.note !== null && typeof body.note !== 'string') throw new ValidationError('note must be a string');
    if (typeof body.note === 'string' && body.note.length > NOTE_MAX) throw new ValidationError(`note must be at most ${NOTE_MAX} characters`);
    note = body.note as string | null;
  }
  if (!await appUserExists(userId)) throw new NotFoundError('No such user');
  // The cap never sits below the allocation (the column CHECK agrees). An
  // omitted cap keeps the stored one, so it must still clear the new figure.
  const existing = await getUserBudget(userId);
  const capAfter = hardCapUsd === undefined ? existing?.hardCapUsd ?? null : hardCapUsd;
  if (capAfter != null && capAfter < allocatedUsd) {
    throw new ValidationError(`hardCapUsd ($${capAfter}) must be at least allocatedUsd ($${allocatedUsd}); raise or clear it`);
  }
  const setBy = resolveSession(req)?.sub ?? null;
  await upsertUserBudget(userId, { allocatedUsd, ...(hardCapUsd !== undefined ? { hardCapUsd } : {}), ...(note !== undefined ? { note } : {}) }, setBy);
  res.json({ budget: await viewFor(userId) });
}));

userBudgetsRouter.delete('/:userId', manageGate, asyncHandler(async (req, res) => {
  const userId = String(req.params['userId'] ?? '').trim();
  if (isSelf(req, userId)) {
    res.status(403).json({ error: 'A user never removes their own budget; ask another budget holder.', gate: 'self-budget' });
    return;
  }
  if (!await deleteUserBudget(userId)) throw new NotFoundError('No budget for that user');
  res.json({ ok: true });
}));

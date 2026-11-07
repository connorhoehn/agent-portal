// Grants — /api/grants
//
// The write side of sprint envelopes (budget_grants). The operating model puts
// this in the release manager's hands: they hold `ManageBudgets`, allocate an
// initiative's monthly budget, then grant a named SME a spend envelope for a
// sprint. Reads of the same table already live at GET /api/budgets/grants; this
// router adds create / re-allocate / revoke, plus a sprint-scoped read so the
// portal has a place to refetch after a write.
//
// Gated in two tiers, mirroring /api/budgets:
//   reads  — operational visibility: org-leader + hr-admin, else ManageBudgets.
//   writes — allocating agent spend is program management: ManageBudgets.
//            A program-owner only on initiatives they own (lib/budget-scope.ts,
//            docs/next-steps.md §9 item 8a).

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction, resolveSession } from '../lib/authz.js';
import { initiativeExists } from '../providers/budgets.js';
import { getSprint, personExists } from '../providers/sprints.js';
import {
  updateGrant, revokeGrant, listGrantsForSprint, getGrant,
} from '../providers/grants.js';
import { grantEnvelope } from '../lib/grant-envelope.js';
import { requireBudgetScope } from '../lib/budget-scope.js';

export const grantsRouter: Router = Router();

const readGate = readForRolesElseAction(['org-leader', 'hr-admin'], 'ManageBudgets');
const manageGate = requireAction('ManageBudgets');

/** Strictly a finite, non-negative number — never a coercible string, NaN, or
 *  Infinity, which would become the envelope every spend read is judged against. */
function validAmount(raw: unknown): number {
  const amount = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationError('amountUsd must be a finite number >= 0');
  }
  return amount;
}

/** DE-36: an optional hard cap on the envelope, at or above its amount. */
function validCap(raw: unknown, amountUsd: number): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new ValidationError('hardCapUsd must be a finite number >= 0, or null');
  if (raw < amountUsd) throw new ValidationError(`hardCapUsd ($${raw}) must be at least amountUsd ($${amountUsd})`);
  return raw;
}

/** The free-text note on an envelope. A string within a sane bound; an empty
 *  string is allowed and clears the note. */
const NOTE_MAX = 500;
function validNote(raw: unknown): string {
  if (typeof raw !== 'string') throw new ValidationError('note must be a string');
  if (raw.length > NOTE_MAX) throw new ValidationError(`note must be at most ${NOTE_MAX} characters`);
  return raw;
}

// ─── Read: a sprint's envelopes ───────────────────────────────────────────────
//   GET /api/grants?sprintId=spr-...  → { grants }
grantsRouter.get('/', readGate, asyncHandler(async (req, res) => {
  const sprintId = String(req.query['sprintId'] ?? '').trim();
  if (!sprintId) throw new ValidationError('sprintId query parameter is required');
  res.json({ grants: await listGrantsForSprint(sprintId) });
}));

// ─── Create an envelope ────────────────────────────────────────────────────────
//   POST /api/grants { initiativeId, sprintId, granteePersonId, amountUsd, note? }
//   → 201 { grant }
grantsRouter.post('/', manageGate, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const initiativeId = String(body['initiativeId'] ?? '').trim();
  const sprintId = String(body['sprintId'] ?? '').trim();
  const granteePersonId = String(body['granteePersonId'] ?? '').trim();
  const note = body['note'] != null ? String(body['note']) : null;

  if (!initiativeId) throw new ValidationError('initiativeId is required');
  if (!sprintId) throw new ValidationError('sprintId is required');
  if (!granteePersonId) throw new ValidationError('granteePersonId is required');
  const amountUsd = validAmount(body['amountUsd']);
  const hardCapUsd = validCap(body['hardCapUsd'], amountUsd);

  if (!await initiativeExists(initiativeId)) throw new NotFoundError('No such initiative');
  if (!await requireBudgetScope(req, res, initiativeId)) return;
  if (!await personExists(granteePersonId)) throw new NotFoundError('No such grantee');

  const sprint = await getSprint(sprintId);
  if (!sprint) throw new NotFoundError('No such sprint');
  // The envelope names both an initiative and a sprint; a sprint that belongs to
  // a different initiative would fund work the grant does not describe.
  if (sprint.orgProjectId !== initiativeId) {
    throw new ValidationError(
      `sprint ${sprintId} belongs to ${sprint.orgProjectId}, not ${initiativeId}`,
    );
  }

  const grantedBy = resolveSession(req)?.sub ?? null;
  // The one grant path (lib/grant-envelope.ts): the row, the grantee's bell and
  // the work graph's live hint — shared with the access tenant's provisioning of
  // an approved sprint-envelope request, so both kinds of envelope read alike.
  const grant = await grantEnvelope({
    orgProjectId: initiativeId, sprintId, granteePersonId, amountUsd, grantedBy, note,
    ...(hardCapUsd != null ? { hardCapUsd } : {}),
  });
  res.status(201).json({ grant });
}));

// ─── Re-allocate and/or re-note ─────────────────────────────────────────────────
//   PATCH /api/grants/:id { amountUsd?, note? }  → { grant }
// Both fields are independently optional so the amount editor and a note fix do
// not clobber each other: send only amountUsd to re-allocate, only note to
// correct a mistyped note (no revoke+recreate), or both. At least one is
// required — an empty patch has nothing to do.
grantsRouter.patch('/:id', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '').trim();
  if (!id) throw new ValidationError('grant id is required');
  const body = (req.body ?? {}) as { amountUsd?: unknown; note?: unknown; hardCapUsd?: unknown };

  const patch: { amountUsd?: number; note?: string; hardCapUsd?: number | null } = {};
  if (body.amountUsd !== undefined) patch.amountUsd = validAmount(body.amountUsd);
  if (body.note !== undefined) patch.note = validNote(body.note);
  if (body.hardCapUsd !== undefined) patch.hardCapUsd = body.hardCapUsd === null ? null : validCap(body.hardCapUsd, 0);
  if (patch.amountUsd === undefined && patch.note === undefined && patch.hardCapUsd === undefined) {
    throw new ValidationError('provide amountUsd and/or note (or hardCapUsd) to update');
  }
  // The envelope's initiative decides whether a program-owner may touch it.
  const current = await getGrant(id);
  if (current && !await requireBudgetScope(req, res, current.orgProjectId)) return;
  // DE-36: the cap never sits below the envelope, whichever of the two moved.
  if (patch.amountUsd !== undefined || patch.hardCapUsd != null) {
    // An unknown id falls through to updateGrant, which answers the 404.
    const amountAfter = patch.amountUsd ?? current?.allocatedUsd ?? 0;
    const capAfter = patch.hardCapUsd === undefined ? current?.hardCapUsd ?? null : patch.hardCapUsd;
    if (current && capAfter != null && capAfter < amountAfter) {
      throw new ValidationError(`hardCapUsd ($${capAfter}) must be at least amountUsd ($${amountAfter}); raise or clear it`);
    }
  }

  const grant = await updateGrant(id, patch);
  if (!grant) throw new NotFoundError('No such grant');
  // Content-free live hint for the activity graph (lib/work-graph/live.ts); lazy so this router's tests do not load the bots provider.
  void import('../lib/work-graph/live.js').then(m => m.notifyWorkGraphChanged(grant.orgProjectId, 'sprint')).catch(() => undefined);
  res.json({ grant });
}));

// ─── Revoke ─────────────────────────────────────────────────────────────────────
//   DELETE /api/grants/:id  → { ok: true }
grantsRouter.delete('/:id', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '').trim();
  const current = await getGrant(id);
  if (current && !await requireBudgetScope(req, res, current.orgProjectId)) return;
  const ok = await revokeGrant(id);
  if (!ok) throw new NotFoundError('No such grant');
  // Content-free live hint for the activity graph (lib/work-graph/live.ts); lazy so this router's tests do not load the bots provider.
  void import('../lib/work-graph/live.js').then(m => m.notifyWorkGraphChanged(null, 'sprint')).catch(() => undefined);
  res.json({ ok: true });
}));

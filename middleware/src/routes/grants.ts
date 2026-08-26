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

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction, resolveSession } from '../lib/authz.js';
import { initiativeExists } from '../providers/budgets.js';
import { getSprint, personExists } from '../providers/sprints.js';
import {
  createGrant, updateGrant, revokeGrant, listGrantsForSprint,
} from '../providers/grants.js';

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

  if (!await initiativeExists(initiativeId)) throw new NotFoundError('No such initiative');
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
  const grant = await createGrant({ orgProjectId: initiativeId, sprintId, granteePersonId, amountUsd, grantedBy, note });
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
  const body = (req.body ?? {}) as { amountUsd?: unknown; note?: unknown };

  const patch: { amountUsd?: number; note?: string } = {};
  if (body.amountUsd !== undefined) patch.amountUsd = validAmount(body.amountUsd);
  if (body.note !== undefined) patch.note = validNote(body.note);
  if (patch.amountUsd === undefined && patch.note === undefined) {
    throw new ValidationError('provide amountUsd and/or note to update');
  }

  const grant = await updateGrant(id, patch);
  if (!grant) throw new NotFoundError('No such grant');
  res.json({ grant });
}));

// ─── Revoke ─────────────────────────────────────────────────────────────────────
//   DELETE /api/grants/:id  → { ok: true }
grantsRouter.delete('/:id', manageGate, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '').trim();
  const ok = await revokeGrant(id);
  if (!ok) throw new NotFoundError('No such grant');
  res.json({ ok: true });
}));

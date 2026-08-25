// Budget grants (sprint envelopes) — the write side of `budget_grants`.
//
// The read side already lives in providers/budgets.ts (`listGrants`, surfaced
// at GET /api/budgets/grants). This module adds create/update/revoke, which the
// program operating model (docs/program-operating-model.md) puts in the release
// manager's hands: they allocate an initiative's budget and then grant an SME a
// spend envelope, normally scoped to one sprint. Gating lives in
// routes/grants.ts (ManageBudgets); this module is persistence only.
//
// Burn is never written here — it is derived at read time from bot_runs inside
// the sprint window (see budgets.GrantRow.initiativeSpendInWindowUsd). A grant
// row stores only the *allocation* and who authorized it.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { type GrantRow, listGrants as budgetsListGrants, MOCK_GRANTS } from './budgets.js';
import { MOCK_BUDGETS } from './budgets.js';
import { getSprint } from './sprints.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : nul(name);
}
function num(name: string, v: number): SqlParameter { return { name, value: { doubleValue: v } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

export interface CreateGrantInput {
  orgProjectId: string;
  sprintId: string;
  granteePersonId: string;
  amountUsd: number;
  grantedBy?: string | null;
  note?: string | null;
}

// ─── Mock overlay (config.mock.aurora === true) ──────────────────────────────
//
// The seed envelopes are budgets.MOCK_GRANTS (read-only). This overlay records
// mutations on top of them so dev:mock can create/patch/revoke in-memory:
//   id → updated row   (a create, or a patched seed/created grant)
//   id → null          (a tombstone: the grant was revoked)
// Reads merge the seed with the overlay; the seed is never mutated in place.

const MOCK_OVERLAY = new Map<string, GrantRow | null>();

/** Test-only: clear the in-memory grant overlay between cases. */
export function _resetMockGrants(): void { MOCK_OVERLAY.clear(); }

function seedGrantRows(): GrantRow[] {
  // Same name-join budgets.listGrants does in mock, kept local so this module
  // does not depend on that path's filtering.
  return MOCK_GRANTS.map((g) => ({
    ...g,
    orgProjectName: MOCK_BUDGETS.find((b) => b.id === g.orgProjectId)?.name ?? null,
  }));
}

function mergedMockGrants(): GrantRow[] {
  const seed = seedGrantRows();
  const seedIds = new Set(seed.map((g) => g.id));
  const out: GrantRow[] = [];
  for (const g of seed) {
    if (MOCK_OVERLAY.has(g.id)) {
      const v = MOCK_OVERLAY.get(g.id);
      if (v) out.push(v); // patched; a tombstone (null) drops it
    } else {
      out.push(g);
    }
  }
  for (const [id, v] of MOCK_OVERLAY) {
    if (!seedIds.has(id) && v) out.push(v);
  }
  return out;
}

async function mockGrantRowFor(input: CreateGrantInput, id: string): Promise<GrantRow> {
  // Pull the sprint's initiative/date labels through getSprint so a created
  // grant reads consistently with the sprint it funds. granteeName is unknown
  // in mock (no people join) and left null — honest, not fabricated.
  const sprint = await getSprint(input.sprintId);
  return {
    id,
    orgProjectId: input.orgProjectId,
    orgProjectName: sprint?.orgProjectName
      ?? MOCK_BUDGETS.find((b) => b.id === input.orgProjectId)?.name ?? null,
    granteePersonId: input.granteePersonId,
    granteeName: sprint?.stewardPersonId === input.granteePersonId ? sprint?.stewardName ?? null : null,
    sprintId: input.sprintId,
    sprintName: sprint?.name ?? null,
    startsOn: sprint?.startsOn ?? null,
    endsOn: sprint?.endsOn ?? null,
    sprintStatus: sprint?.status ?? null,
    allocatedUsd: input.amountUsd,
    grantedBy: input.grantedBy ?? null,
    initiativeSpendInWindowUsd: 0,
  };
}

// ─── Read (one grant, and a scoped list) ─────────────────────────────────────

/** One grant by id, projected through the read shape. Null when unknown. */
export async function getGrant(id: string): Promise<GrantRow | null> {
  if (config.mock.aurora) {
    return mergedMockGrants().find((g) => g.id === id) ?? null;
  }
  // No initiative scope known up front, so read unscoped and pick the row out.
  const all = await budgetsListGrants();
  return all.find((g) => g.id === id) ?? null;
}

/** Grants for one sprint (the portal's read-back target after a write). */
export async function listGrantsForSprint(sprintId: string): Promise<GrantRow[]> {
  if (config.mock.aurora) {
    return mergedMockGrants().filter((g) => g.sprintId === sprintId);
  }
  const all = await budgetsListGrants();
  return all.filter((g) => g.sprintId === sprintId);
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createGrant(input: CreateGrantInput): Promise<GrantRow> {
  if (config.mock.aurora) {
    const id = `bg-mock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const row = await mockGrantRowFor(input, id);
    MOCK_OVERLAY.set(id, row);
    return row;
  }
  const rows = await exec(
    `INSERT INTO budget_grants (org_project_id, sprint_id, grantee_person_id, allocated_usd, granted_by, note)
     VALUES (:pid, :sprint, :grantee, :amt, :by, :note)
     RETURNING id`,
    [
      s('pid', input.orgProjectId),
      s('sprint', input.sprintId),
      s('grantee', input.granteePersonId),
      num('amt', input.amountUsd),
      maybe('by', input.grantedBy),
      maybe('note', input.note),
    ],
  );
  const id = toStr(rows[0]?.['id']);
  const created = await getGrant(id);
  if (created) return created;
  throw new Error('grant was inserted but could not be read back');
}

// ─── Update (re-allocate the envelope) ───────────────────────────────────────

/** Change a grant's dollar amount. Returns null when the id is unknown. */
export async function updateGrantAmount(id: string, amountUsd: number): Promise<GrantRow | null> {
  if (config.mock.aurora) {
    const current = mergedMockGrants().find((g) => g.id === id);
    if (!current) return null;
    const updated: GrantRow = { ...current, allocatedUsd: amountUsd };
    MOCK_OVERLAY.set(id, updated);
    return updated;
  }
  const rows = await exec(
    `UPDATE budget_grants SET allocated_usd = :amt, updated_at = NOW()
      WHERE id = :id
      RETURNING id`,
    [num('amt', amountUsd), s('id', id)],
  );
  if (rows.length === 0) return null;
  return getGrant(id);
}

// ─── Revoke ───────────────────────────────────────────────────────────────────

/** Delete a grant. Returns false when nothing matched the id. */
export async function revokeGrant(id: string): Promise<boolean> {
  if (config.mock.aurora) {
    const exists = mergedMockGrants().some((g) => g.id === id);
    if (!exists) return false;
    MOCK_OVERLAY.set(id, null); // tombstone; the seed array is never mutated
    return true;
  }
  const rows = await exec(
    `DELETE FROM budget_grants WHERE id = :id RETURNING id`,
    [s('id', id)],
  );
  return rows.length > 0;
}

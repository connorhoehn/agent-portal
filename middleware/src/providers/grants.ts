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
import {
  type GrantRow, listGrants as budgetsListGrants, MOCK_BUDGETS,
  mockInitiativeWindowSpendUsd,
} from './budgets.js';
import {
  mergedMockGrants,
  setMockGrant,
  tombstoneMockGrant,
  _resetMockGrants,
} from './grantOverlay.js';
import { getSprint } from './sprints.js';
// The one clock. A created grant's id carries an instant, and a fixture instant
// is read through the clock so a frozen test freezes it too.
import { clock } from '../mock/core/index.js';
import { mockPeople } from '../mock/people.js';

// Re-exported so existing test imports (`_resetMockGrants` from this module)
// keep working now that the overlay itself lives next door.
export { _resetMockGrants };

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : nul(name);
}
function num(name: string, v: number): SqlParameter { return { name, value: { doubleValue: v } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

export interface CreateGrantInput {
  orgProjectId: string;
  /** Null = an initiative-level standing grant (budget_grants.sprint_id is nullable): the
   *  access tenant provisions one when the initiative has no active sprint (2026-10-28). */
  sprintId: string | null;
  granteePersonId: string;
  amountUsd: number;
  grantedBy?: string | null;
  note?: string | null;
  /** DE-36: null/absent = the deployment default (allocated x BUDGET_HARD_CAP_FACTOR). */
  hardCapUsd?: number | null;
}

// ─── Mock overlay (config.mock.aurora === true) ──────────────────────────────
//
// The overlay itself lives in providers/grantOverlay.ts. It was moved there so
// sprints.ts can read it too: this module imports getSprint from sprints.ts, so
// sprints.ts importing THIS module would close a cycle. While the overlay lived
// here, sprints.ts read the raw seed instead and reported a stale envelope after
// every grant PATCH. See that file's header for the full reasoning.

/**
 * Re-attach the window burn as a live getter.
 *
 * `initiativeSpendInWindowUsd` is derived on the Aurora side (a SUM over
 * bot_runs inside the sprint window) and must never be stored beside the row —
 * see the `mockGrant` note in providers/budgets.ts. Every row this module puts
 * into the overlay goes through here, so a created or patched grant is summed
 * from the runs at read time exactly like a seed row is, including for the
 * readers that go straight to `mergedMockGrants()` (providers/sprints.ts).
 * Without this a create wrote a literal 0 and a patch froze whatever the burn
 * happened to be at the moment of the spread.
 */
function withDerivedWindowSpend(row: Omit<GrantRow, 'initiativeSpendInWindowUsd'>): GrantRow {
  return {
    ...row,
    get initiativeSpendInWindowUsd(): number {
      return mockInitiativeWindowSpendUsd(row.orgProjectId, row.startsOn, row.endsOn);
    },
  };
}

async function mockGrantRowFor(input: CreateGrantInput, id: string): Promise<GrantRow> {
  // Pull the sprint's initiative/date labels through getSprint so a created
  // grant reads consistently with the sprint it funds. granteeName is the
  // people-table name of the grantee (the join `budgetsListGrants` does on
  // Aurora), so a new envelope reads "Nora DaSilva", not "p-004".
  const sprint = input.sprintId ? await getSprint(input.sprintId) : null;
  return withDerivedWindowSpend({
    id,
    orgProjectId: input.orgProjectId,
    orgProjectName: sprint?.orgProjectName
      ?? MOCK_BUDGETS.find((b) => b.id === input.orgProjectId)?.name ?? null,
    granteePersonId: input.granteePersonId,
    granteeName: mockPeople.find((p) => p.id === input.granteePersonId)?.name
      ?? (sprint?.stewardPersonId === input.granteePersonId ? sprint?.stewardName ?? null : null),
    sprintId: input.sprintId,
    sprintName: sprint?.name ?? null,
    startsOn: sprint?.startsOn ?? null,
    endsOn: sprint?.endsOn ?? null,
    sprintStatus: sprint?.status ?? null,
    allocatedUsd: input.amountUsd,
    grantedBy: input.grantedBy ?? null,
    note: input.note ?? null,
    hardCapUsd: input.hardCapUsd ?? null,
  });
}

// ─── Read (one grant, and a scoped list) ─────────────────────────────────────

/** One grant by id, projected through the read shape. Null when unknown. */
export async function getGrant(id: string): Promise<GrantRow | null> {
  if (config.mock.aurora) {
    const row = mergedMockGrants().find((g) => g.id === id);
    return row ? withDerivedWindowSpend(row) : null;
  }
  // No initiative scope known up front, so read unscoped and pick the row out.
  const all = await budgetsListGrants();
  return all.find((g) => g.id === id) ?? null;
}

/** Grants for one sprint (the portal's read-back target after a write). */
export async function listGrantsForSprint(sprintId: string): Promise<GrantRow[]> {
  if (config.mock.aurora) {
    return mergedMockGrants().filter((g) => g.sprintId === sprintId).map(withDerivedWindowSpend);
  }
  const all = await budgetsListGrants();
  return all.filter((g) => g.sprintId === sprintId);
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function createGrant(input: CreateGrantInput): Promise<GrantRow> {
  if (config.mock.aurora) {
    // The instant comes from the mock clock, not `Date.now()`: a fixture id is
    // a fixture timestamp with a prefix, and a frozen test that cannot predict
    // the id it just created cannot assert on it. The random suffix is what
    // keeps two creates apart, so reading the clock half through the clock
    // costs no uniqueness — including under one frozen instant.
    const id = `bg-mock-${clock.now().getTime()}-${Math.floor(Math.random() * 1e6)}`;
    const row = await mockGrantRowFor(input, id);
    setMockGrant(id, row);
    return row;
  }
  const withCap = input.hardCapUsd != null;
  const rows = await exec(
    `INSERT INTO budget_grants (org_project_id, sprint_id, grantee_person_id, allocated_usd, granted_by, note${withCap ? ', hard_cap_usd' : ''})
     VALUES (:pid, :sprint, :grantee, :amt, :by, :note${withCap ? ', :cap' : ''})
     RETURNING id`,
    [
      ...(withCap ? [num('cap', input.hardCapUsd!)] : []),
      s('pid', input.orgProjectId),
      maybe('sprint', input.sprintId),
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

// ─── Update (re-allocate the envelope, and/or re-note it) ────────────────────

/** A grant patch: change the dollar amount, the note, or both. Each field is
 *  independently optional — `undefined` means "leave this column alone", so the
 *  amount editor and a note fix don't clobber each other. `note: null` clears a
 *  note; `note: ''` is treated the same by the route's validation. */
export interface UpdateGrantInput {
  amountUsd?: number;
  note?: string | null;
  /** DE-36: undefined = leave alone; null = back to the default. */
  hardCapUsd?: number | null;
}

/**
 * Patch a grant's amount and/or note. Returns null when the id is unknown.
 *
 * Whichever fields are present are written; a patch with neither is a no-op read
 * (so the route still gets the current row back rather than a spurious NULL).
 * The SET clause is built from the provided fields — amount first, then note,
 * then updated_at, then the id bind last — so an amount-only patch produces
 * exactly the historical statement and binding order.
 *
 * `note` is carried on GrantRow and surfaced on read, so a note-only patch is
 * observable in both modes. (It was not always: while GrantRow had no `note`,
 * a saved note read back as `—` because no read path could express it.)
 */
export async function updateGrant(id: string, patch: UpdateGrantInput): Promise<GrantRow | null> {
  const setAmount = patch.amountUsd !== undefined;
  const setNote = patch.note !== undefined;
  const setCap = patch.hardCapUsd !== undefined;
  if (!setAmount && !setNote && !setCap) return getGrant(id);

  if (config.mock.aurora) {
    const current = mergedMockGrants().find((g) => g.id === id);
    if (!current) return null;
    // Rebuilt through withDerivedWindowSpend: the spread below would otherwise
    // flatten the burn getter into a frozen number and store it on the overlay.
    const updated: GrantRow = withDerivedWindowSpend({
      ...current,
      ...(setAmount ? { allocatedUsd: patch.amountUsd! } : {}),
      // Mirrors the real SET clause: only a provided field is written, so a
      // note-only patch leaves the amount alone and vice versa.
      ...(setNote ? { note: patch.note ?? null } : {}),
      ...(setCap ? { hardCapUsd: patch.hardCapUsd ?? null } : {}),
    });
    setMockGrant(id, updated);
    return updated;
  }

  const sets: string[] = [];
  const params: SqlParameter[] = [];
  if (setAmount) { sets.push('allocated_usd = :amt'); params.push(num('amt', patch.amountUsd!)); }
  if (setNote) { sets.push('note = :note'); params.push(maybe('note', patch.note)); }
  if (setCap) {
    sets.push('hard_cap_usd = :cap::numeric');
    params.push(patch.hardCapUsd == null ? nul('cap') : num('cap', patch.hardCapUsd));
  }
  sets.push('updated_at = NOW()');
  params.push(s('id', id));

  const rows = await exec(
    `UPDATE budget_grants SET ${sets.join(', ')}
      WHERE id = :id
      RETURNING id`,
    params,
  );
  if (rows.length === 0) return null;
  return getGrant(id);
}

/** Change a grant's dollar amount. Returns null when the id is unknown.
 *  Thin wrapper over updateGrant, kept for existing callers. */
export async function updateGrantAmount(id: string, amountUsd: number): Promise<GrantRow | null> {
  return updateGrant(id, { amountUsd });
}

// ─── Revoke ───────────────────────────────────────────────────────────────────

/** Delete a grant. Returns false when nothing matched the id. */
export async function revokeGrant(id: string): Promise<boolean> {
  if (config.mock.aurora) {
    const exists = mergedMockGrants().some((g) => g.id === id);
    if (!exists) return false;
    tombstoneMockGrant(id); // the seed array is never mutated
    return true;
  }
  const rows = await exec(
    `DELETE FROM budget_grants WHERE id = :id RETURNING id`,
    [s('id', id)],
  );
  return rows.length > 0;
}

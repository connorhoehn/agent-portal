// providers/grantOverlay.ts
//
// The mock `budget_grants` table — the one read that every offline grant
// mutation is visible through.
//
// WHY THIS IS ITS OWN MODULE, and not part of providers/grants.ts where it
// started: two readers need it, and they cannot both import grants.ts.
//
//   grants.ts  imports getSprint from sprints.ts  (to label a created grant)
//   sprints.ts needs the merged grants            (to roll up a sprint envelope)
//
// so sprints.ts -> grants.ts would close an import cycle. While this lived in
// grants.ts, sprints.ts read the raw seed instead — and that was a real,
// user-visible bug: PATCH a grant and /api/grants reported the new amount while
// /api/sprints kept reporting the old envelope, because only one of them knew
// the mutations existed.
//
// This module imports budgets.ts only, so both can depend on it and neither
// depends on the other. Nothing here should ever import grants.ts or sprints.ts.
//
// WHAT CHANGED. There used to be an OVERLAY here: a `Map<id, GrantRow | null>`
// recording creates, patches and tombstones on top of a seed array that was
// never allowed to change. That existed for exactly one reason — there was no
// way to put the seed back, so the seed had to be read-only, and every reader
// had to know to merge two things. A REGISTERED FIXTURE is that way:
// `budgetGrants` (mock/budgets.ts) is in the registry, so `POST /api/__mock/reset`
// restores it and the rows can simply be mutated. The merge, the tombstones and
// the "read this, not that" rule are all gone; the exported names stay because
// grants.ts and sprints.ts call them.

import { type GrantRow, type MockGrantSeed, MOCK_BUDGETS, MOCK_GRANTS } from './budgets.js';
import { budgetGrants } from '../mock/budgets.js';

/** Test-only: put the seeded envelopes back, dropping anything this process
 *  created, patched or revoked. `fixtureRegistry.resetAll()` (POST
 *  /api/__mock/reset) does the same, which is the point of the fixture. */
export function _resetMockGrants(): void { budgetGrants.reset(); }

/**
 * The stored half of a grant row.
 *
 * `budget_grants` holds an allocation, a grantee, a sprint and who authorized
 * it — and nothing else. `orgProjectName` is a projects join,
 * `startsOn`/`endsOn` are the SPRINT's dates, and `initiativeSpendInWindowUsd`
 * is a correlated SUM over bot_runs. All four are re-attached on the way out
 * (`mockGrant` in providers/budgets.ts), so a create or a patch cannot freeze
 * one of them into the table the way the old overlay did.
 */
function toSeed(row: GrantRow): MockGrantSeed {
  return {
    id: row.id,
    orgProjectId: row.orgProjectId,
    granteePersonId: row.granteePersonId,
    granteeName: row.granteeName,
    sprintId: row.sprintId,
    sprintName: row.sprintName,
    sprintStatus: row.sprintStatus,
    allocatedUsd: row.allocatedUsd,
    grantedBy: row.grantedBy,
    note: row.note,
  };
}

/** Record a create or a patch — an upsert against the fixture, matching the
 *  INSERT and the UPDATE ... RETURNING in providers/grants.ts. */
export function setMockGrant(id: string, row: GrantRow): void {
  const rows = budgetGrants.rows();
  const at = rows.findIndex((g) => g.id === id);
  const seed = { ...toSeed(row), id };
  if (at < 0) rows.push(seed);
  else rows[at] = seed;
}

/** Record a revoke. The row leaves the table, exactly as `DELETE FROM
 *  budget_grants` does — no tombstone, because there is no read-only seed
 *  underneath it any more to shadow. */
export function tombstoneMockGrant(id: string): void {
  const rows = budgetGrants.rows();
  const at = rows.findIndex((g) => g.id === id);
  if (at >= 0) rows.splice(at, 1);
}

/**
 * Every mock grant, projected the way listGrants projects a real one.
 *
 * The name kept its "merged" spelling because two dozen call sites and two test
 * suites use it, and because what it promises is unchanged: this is the read
 * that sees mutations. There is simply nothing to merge any more.
 *
 * `MOCK_GRANTS` is a live view over the fixture whose rows carry `startsOn`,
 * `endsOn` and the window burn as GETTERS, so spreading here resolves each of
 * them at read time — the initiative name is the only thing this function adds.
 */
export function mergedMockGrants(): GrantRow[] {
  return MOCK_GRANTS.map((g) => ({
    ...g,
    orgProjectName: MOCK_BUDGETS.find((b) => b.id === g.orgProjectId)?.name ?? null,
  }));
}

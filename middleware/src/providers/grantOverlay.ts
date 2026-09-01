// providers/grantOverlay.ts
//
// The in-memory grant overlay for mock mode (config.mock.aurora === true).
//
// WHY THIS IS ITS OWN MODULE, and not part of providers/grants.ts where it
// started: two readers need it, and they cannot both import grants.ts.
//
//   grants.ts  imports getSprint from sprints.ts  (to label a created grant)
//   sprints.ts needs the merged grants            (to roll up a sprint envelope)
//
// so sprints.ts -> grants.ts would close an import cycle. While the overlay
// lived in grants.ts, sprints.ts read the raw `MOCK_GRANTS` seed instead — and
// that was a real, user-visible bug: PATCH a grant and /api/grants reported the
// new amount while /api/sprints kept reporting the old envelope, because only
// one of them knew the overlay existed.
//
// This module imports budgets.ts only, so both can depend on it and neither
// depends on the other. Nothing here should ever import grants.ts or sprints.ts.
//
// The model:
//   The seed envelopes are budgets.MOCK_GRANTS and are READ-ONLY. The overlay
//   records mutations on top of them so dev:mock can create/patch/revoke:
//     id -> updated row   (a create, or a patched seed/created grant)
//     id -> null          (a tombstone: the grant was revoked)
//   Reads merge the seed with the overlay; the seed is never mutated in place.

import { type GrantRow, MOCK_GRANTS, MOCK_BUDGETS } from './budgets.js';

const MOCK_OVERLAY = new Map<string, GrantRow | null>();

/** Test-only: clear the in-memory grant overlay between cases. */
export function _resetMockGrants(): void { MOCK_OVERLAY.clear(); }

/** Record a create or a patch. */
export function setMockGrant(id: string, row: GrantRow): void { MOCK_OVERLAY.set(id, row); }

/** Record a revoke. A tombstone, so the seed row stops being read. */
export function tombstoneMockGrant(id: string): void { MOCK_OVERLAY.set(id, null); }

function seedGrantRows(): GrantRow[] {
  // Same name-join budgets.listGrants does in mock, kept local so this module
  // does not depend on that path's filtering.
  return MOCK_GRANTS.map((g) => ({
    ...g,
    orgProjectName: MOCK_BUDGETS.find((b) => b.id === g.orgProjectId)?.name ?? null,
  }));
}

/**
 * The seed with the overlay applied — the ONLY honest read of mock grants.
 * Read this rather than `MOCK_GRANTS` anywhere a mutation should be visible.
 */
export function mergedMockGrants(): GrantRow[] {
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

// Ephemeral identity clones — a test user minted from a seed persona.
//
// WHY THIS EXISTS. A tenant or role switch bumps the user's session epoch, and
// the grants refresh drops every older cookie that user holds (lib/session.ts).
// So two browser runs "as u-vera" revoked each other within 120 s, and every
// parallel audit, journey and e2e queued behind one identity. A clone carries
// the persona's grants and person link under its OWN id, so its epoch is its
// own: a switch on one clone revokes nothing else.
//
// A clone is a row in a registered fixture, so `POST /api/__mock/reset`
// removes every clone (and, with it, every session minted for one: the next
// grants refresh finds no user). A global scenario switch keeps them — the
// control plane carries the rows across `resetAll` — because another auditor
// asking for `empty` must not sign this run out. Clones also expire
// (`expiresAt`), after which they read as a deleted account.
//
// Unscoped (`scoped: false`): the directory is one per process.

import { clock, defineFixture } from './core/index.js';
import { removeCloneDmFixtures } from './clone-dm-cleanup.js';

export interface IdentityCloneRow {
  id: string;
  /** The seed persona this was cloned from. */
  from: string;
  label: string | null;
  displayName: string;
  email: string | null;
  personId: string | null;
  /** A snapshot of the persona's grants when cloned; later grant writes to the persona do not follow. */
  grants: Record<string, string[]>;
  /** The clone's own session epoch. */
  epoch: number;
  createdAt: string;
  expiresAt: string;
}

export const identityClonesFixture = defineFixture<IdentityCloneRow>({
  key: 'identity.clones',
  scoped: false,
  scenarios: {
    default: () => [],
  },
});

export const DEFAULT_CLONE_TTL_MS = 2 * 60 * 60_000;
export const MAX_CLONE_TTL_MS = 12 * 60 * 60_000;
export const MAX_CLONES = 200;

/** Live clones; expired rows are dropped on the way. */
export function liveClones(): IdentityCloneRow[] {
  const rows = identityClonesFixture.rows();
  const now = clock.now().getTime();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Date.parse(rows[i]!.expiresAt) <= now) {
      const [expired] = rows.splice(i, 1);
      removeCloneDmFixtures(expired!.id);
    }
  }
  return rows;
}

export function findClone(id: string): IdentityCloneRow | null {
  return liveClones().find((c) => c.id === id) ?? null;
}

export function removeClone(id: string): boolean {
  const rows = identityClonesFixture.rows();
  const at = rows.findIndex((c) => c.id === id);
  if (at < 0) return false;
  rows.splice(at, 1);
  removeCloneDmFixtures(id);
  return true;
}

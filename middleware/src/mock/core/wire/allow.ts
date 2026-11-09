// Accepted disagreements. Every entry carries a REASON, for the same reason
// the parity harness's `knownDrift` does: an unexplained exemption is how
// drift becomes permanent, and a silent one is indistinguishable from the bug.
//
// Reach for this only when the fixture is right and the snapshot cannot see
// it. In practice that is one of three things:
//
//   * the fixture is deliberately wrong, as input to a test about wrongness
//     ("an unknown role is denied, not defaulted");
//   * the route is uncaptured — see the `skipped` entries in `wire.json` and
//     in `writes.json` — and the honest fix is to make it capturable, not to
//     exempt the fixture;
//   * the write that produces the string is one `write-policy.ts` REFUSES to
//     replay (it spends, it fires, it deletes). The refusal is recorded with
//     its rule in `writes.json`, so cite that rule here rather than restating
//     it, and say why the fixture must carry the string anyway.
//
// "The string only exists after a POST, and capture is GET-only" USED to be the
// first item on this list. It is no longer true: `capture-writes.ts` replays
// every write `write-policy.ts` allows and feeds those response shapes into the
// same check. No entry below ever leant on it — the one exemption here is a
// deliberately-wrong fixture — so nothing had to be reclassified when the
// reason disappeared. Do not reintroduce it.
//
// A REAL disagreement — the app reading something the server does not send —
// is marked `bug: true`. That does not silence it: the sweep prints those as a
// separate roll-up so they stay visible until someone fixes the product, and
// an entry that is quietly deleted takes the evidence with it.

export interface AllowEntry {
  /** Repo-relative path, or a prefix ending in `/`. */
  file: string;
  /** Exempt a wire value: `{ field: 'status', value: 'queued' }`. */
  field?: string;
  value?: string;
  /** Exempt an invented key name. */
  key?: string;
  /** Why. Required — a bare exemption is not accepted. */
  reason: string;
  /**
   * This is a known PRODUCT bug, not an accepted fixture. Reported in the
   * known-bugs roll-up rather than passed over in silence.
   */
  bug?: boolean;
}

export const ALLOWED: { file: string; entries: AllowEntry[] } = {
  file: 'middleware/src/mock/core/wire/allow.ts',
  entries: [
    {
      file: 'middleware/src/lib/__tests__/authz-open-mode.test.ts',
      field: 'role',
      value: 'ghost',
      reason:
        'Deliberately not a role. The test is "an unknown role is denied, not ' +
        'defaulted" — a role the server DOES send would not test anything.',
    },
    {
      file: 'portal/src/components/communication/__tests__/planeRailModel.test.ts',
      field: 'status',
      value: 'away',
      reason:
        'Not a wire value. `away` is the library ActivePerson status the shell ' +
        'derives from a presence entry\'s idle flag (EmbeddedSocialProvider) before ' +
        'the plane/active enrichment is merged in; the test feeds that client-side ' +
        'tile shape, and `GET /api/social/plane/active` only ever sends online/busy/offline.',
    },
    {
      file: 'middleware/src/lib/__tests__/sdlc-policy.test.ts',
      field: 'action',
      value: 'blocK',
      reason:
        'Deliberately not an action. The test is "normalizePolicy defaults an ' +
        'unknown action to require_approval" (DE-46 policy-set validation) — an ' +
        'action the server DOES send would not test the default.',
    },
    {
      file: 'middleware/src/lib/__tests__/sdlc-policy.test.ts',
      field: 'kind',
      value: 'vibes',
      reason:
        'Deliberately not a kind. The test is "normalizePolicy refuses an unknown ' +
        'kind" (DE-46 policy-set validation) — a kind the server DOES send would ' +
        'not be refused.',
    },
  ],
};

function matches(e: AllowEntry, file: string, what: { field?: string; value?: string; key?: string }): boolean {
  if (!e.reason.trim()) return false;
  const fileMatches = e.file.endsWith('/') ? file.startsWith(e.file) : file === e.file;
  if (!fileMatches) return false;
  if (e.key !== undefined) return what.key === e.key;
  if (e.field !== undefined && e.field !== what.field) return false;
  if (e.value !== undefined && e.value !== what.value) return false;
  return e.field !== undefined || e.value !== undefined;
}

export function isAllowed(
  file: string,
  what: { field?: string; value?: string; key?: string },
): boolean {
  return ALLOWED.entries.some((e) => matches(e, file, what));
}

/** The entries marked `bug: true` — printed, never silent. */
export function knownBugs(): AllowEntry[] {
  return ALLOWED.entries.filter((e) => e.bug === true);
}

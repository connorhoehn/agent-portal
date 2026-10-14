// Grant writes to the offline identity directory (user_tenant_roles), as a
// registered fixture so `POST /api/__mock/reset` undoes them.
//
// providers/identity.ts keeps its seed mirror (FALLBACK_USERS) as the
// directory when Aurora is unconfigured. A `setGrants` there used to throw, so
// nothing offline could change a grant; the access tenant provisions through
// `setGrants` (docs/access-tenant-design.md decision A2), so the mock needs
// somewhere honest to write. One row per user whose grants were REPLACED,
// holding the full replacement (setGrants is wholesale, like the SQL path:
// DELETE every row for the user, INSERT the new set). A user with no row
// reads the seed. The default scenario is empty: the seed IS the default.

import { defineFixture } from './core/index.js';

export interface IdentityGrantWriteRow {
  userId: string;
  /** tenant → roles, the user's whole grant set after the write. */
  grants: Record<string, string[]>;
}

export const identityGrantWritesFixture = defineFixture<IdentityGrantWriteRow>({
  key: 'identity.grant-writes',
  // Identity is one directory for the whole process: the session middleware
  // reads it before any request scope is entered, so a scope must not fork it.
  scoped: false,
  scenarios: {
    default: () => [],
  },
});

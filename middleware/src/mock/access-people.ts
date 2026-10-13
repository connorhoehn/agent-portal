// The access cast's people rows and `people.manager_id` (schema/access_schema.sql),
// offline. The live column is additive on `people`; the org-graph people
// fixture (mock/people.ts) mirrors schema/seed.sql's 56-person cast and carries
// no manager, so the manager links the access tenant reads live here.
//
// A row is a `people` row: id, name, email, managerId (people.manager_id).
// lib/access/ resolves a beneficiary's manager through these rows only — the
// same lookup the Aurora path runs against `people.manager_id` — so Omar
// decides Rhea's manager step with no fixture-specific code in the resolver.
// Registered, so `POST /api/__mock/reset` restores it.

import { defineFixture } from './core/index.js';

export interface AccessPersonRow {
  id: string;
  name: string;
  email: string;
  /** people.manager_id — null when the person has no manager on record. */
  managerId: string | null;
}

export const accessPeopleFixture = defineFixture<AccessPersonRow>({
  key: 'access.people',
  scenarios: {
    default: () => [
      { id: 'p-priya', name: 'Priya Venkataraman', email: 'priya.venkataraman@orgiq.example', managerId: null },
      { id: 'p-omar', name: 'Omar Haddad', email: 'omar.haddad@orgiq.example', managerId: 'p-priya' },
      { id: 'p-rhea', name: 'Rhea Castellanos', email: 'rhea.castellanos@orgiq.example', managerId: 'p-omar' },
    ],
  },
});

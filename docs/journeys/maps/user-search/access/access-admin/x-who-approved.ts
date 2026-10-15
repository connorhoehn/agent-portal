import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog x-who-approved (access access-admin): Priya approved both steps of req-0003.
export default {
  family: 'user-search', log: 'access/access-admin-x-who-approved', kind: 'intent', persona: P.priya, scenario: 'shared', identity: 'clone',
  goal: "Find who approved req-0003 in the audit log",
  fields: { surface: "list search", pages: "portal/src/pages/access" },
  steps: [
    ...listSearch("/access/audit", "Search events", "req-0003", [/req-0003/]),
    open(link(/req-0003/), /^\/access\/requests\/req-0003/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

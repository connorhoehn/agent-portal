import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog x-sod (access access-admin): sod-001 and sod-002.
export default {
  family: 'user-search', log: 'access/access-admin-x-sod', kind: 'intent', persona: P.priya, scenario: 'shared', identity: 'clone',
  goal: "Find the blocking separation-of-duties policies",
  fields: { surface: "list command composer", pages: "portal/src/pages/access" },
  steps: [
    ...composer("/access/policies", "show blocking policies", [/Spend and allocate|Write and approve a pipeline/]),
    open(link(/Spend and allocate|Write and approve a pipeline/), /^\/access\/policies/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

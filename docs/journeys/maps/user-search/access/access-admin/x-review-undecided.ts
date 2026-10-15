import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog x-review-undecided (access access-admin): rev-0001 Q4 SME certification.
export default {
  family: 'user-search', log: 'access/access-admin-x-review-undecided', kind: 'intent', persona: P.priya, scenario: 'shared', identity: 'clone',
  goal: "Find who still needs a review decision",
  fields: { surface: "list command composer", pages: "portal/src/pages/access" },
  hold: HOLD.tenantSearch,
  steps: [
    ...composer("/access/reviews", "show open reviews", [/Q4 SME certification/]),
    open(link(/Q4 SME certification/), /^\/access\/reviews\/rev-0001/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

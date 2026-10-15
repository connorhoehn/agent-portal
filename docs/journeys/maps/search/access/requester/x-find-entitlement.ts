import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog x-find-entitlement (access requester): capability:orgiq:budgets-read.
export default {
  family: 'search', log: 'access/requester-x-find-entitlement', kind: 'intent', persona: P.rhea, scenario: 'shared', identity: 'clone',
  goal: "Find how to get budget access in the catalog",
  fields: { surface: "list search", pages: "portal/src/pages/access" },
  steps: [
    ...listSearch("/access/catalog", "Search the catalog", "budget", [/Budget visibility/]),
    open(link(/Budget visibility/), /^\/access\/catalog/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog a-submission-by (assessment assessor): Jordan Lee's submission on TEAM-002.
export default {
  family: 'user-search', log: 'assessment/assessor-a-submission-by', kind: 'intent', persona: P.asha, scenario: 'shared', identity: 'clone',
  goal: "Find Jordan Lee's submission from the submissions list",
  fields: { surface: "list search", pages: "portal/src/pages/assessment" },
  steps: [
    ...listSearch("/assessment/submissions", "Search submissions", "jordan", [/jordan.lee/]),
    open(link(/jordan.lee/i), /^\/assessment\/submissions\//, 'The row opens its record'),
  ],
} satisfies JourneyMap;

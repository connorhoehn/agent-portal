import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog a-running (assessment assessor): score-dimensions on TEAM-003.
export default {
  family: 'user-search', log: 'assessment/assessor-a-running', kind: 'intent', persona: P.asha, scenario: 'shared', identity: 'clone',
  goal: "See what is running now",
  fields: { surface: "list command composer", pages: "portal/src/pages/assessment/RunsPage.tsx" },
  hold: HOLD.tenantSearch,
  steps: [
    ...composer("/assessment/runs", "show running runs", [/score-dimensions|Checkout Experience/]),
    open(link(/score-dimensions|Checkout Experience/), /^\/assessment\/runs/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog a-failed-runs (assessment lead-assessor): the failed runs.
export default {
  family: 'user-search', log: 'assessment/lead-assessor-a-failed-runs', kind: 'intent', persona: P.jonas, scenario: 'shared', identity: 'clone',
  goal: "See which assessment runs failed",
  fields: { surface: "list command composer", pages: "portal/src/pages/assessment/RunsPage.tsx" },
  steps: [
    ...composer("/assessment/runs", "show failed runs", [/Suggest confluence content|Process self assessment/, /with status failed/]),
    open(link(/Suggest confluence content|Process self assessment/), /^\/assessment\/runs\//, 'The row opens its record'),
  ],
} satisfies JourneyMap;

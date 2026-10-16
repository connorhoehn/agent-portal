import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog a-team-lead (assessment assessor): "Data Platform lead" — Farah Osei leads TEAM-004.
export default {
  family: 'user-search', log: 'assessment/assessor-a-team-lead', kind: 'intent', persona: P.asha, scenario: 'shared', identity: 'clone',
  goal: "Find who leads Data Platform from the teams list",
  fields: { surface: "list search", pages: "portal/src/pages/assessment" },
  steps: [
    ...listSearch("/assessment/teams", "Search by team name or ID\u2026", "Data Platform", [/Farah Osei/]),
    open(link(/Data Platform/), /^\/assessment\/teams\/TEAM-004/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

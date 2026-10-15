import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog a-team-lookup (assessment assessor): "Northstar Payments" — TEAM-001.
export default {
  family: 'user-search', log: 'assessment/assessor-a-team-lookup', kind: 'intent', persona: P.asha, scenario: 'shared', identity: 'clone',
  goal: "Jump to a team by name from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/assessment/teams", "Northstar Payments", /Northstar Payments/, /^\/assessment\/teams\/TEAM-001/),
  ],
} satisfies JourneyMap;

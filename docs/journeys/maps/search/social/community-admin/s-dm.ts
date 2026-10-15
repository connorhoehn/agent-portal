import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog s-dm (social community-admin): the DM with Theo.
export default {
  family: 'search', log: 'social/community-admin-s-dm', kind: 'intent', persona: P.mira, scenario: 'shared', identity: 'clone',
  goal: "Jump to a direct conversation from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/social/channels", "Theo Chang", /Theo/, /^\/social\/dms/),
  ],
} satisfies JourneyMap;

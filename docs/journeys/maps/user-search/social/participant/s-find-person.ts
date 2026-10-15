import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog s-find-person (social participant): a person by name.
export default {
  family: 'user-search', log: 'social/participant-s-find-person', kind: 'intent', persona: P.sana, scenario: 'shared', identity: 'clone',
  goal: "Jump to a person from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/social/channels", "Lena", /Lena/, /^\/social\//),
  ],
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog s-room (social participant): a room by name.
export default {
  family: 'search', log: 'social/participant-s-room', kind: 'intent', persona: P.sana, scenario: 'shared', identity: 'clone',
  goal: "Jump to a room from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/social/channels", "room", /room/, /^\/social\/rooms/),
  ],
} satisfies JourneyMap;

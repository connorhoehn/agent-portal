import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog s-find-channel (social participant): "incidents" — the #incidents channel.
export default {
  family: 'search', log: 'social/participant-s-find-channel', kind: 'intent', persona: P.sana, scenario: 'shared', identity: 'clone',
  goal: "Jump to a channel from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/social/channels", "incidents", /incidents/, /^\/social\/channels/),
  ],
} satisfies JourneyMap;

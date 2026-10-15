import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog s-team-members (social moderator): a social team's members.
export default {
  family: 'user-search', log: 'social/moderator-s-team-members', kind: 'intent', persona: P.lena, scenario: 'shared', identity: 'clone',
  goal: "Find who is on a team from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/social/channels", "moderation team", /team/, /^\/social\/teams/),
  ],
} satisfies JourneyMap;

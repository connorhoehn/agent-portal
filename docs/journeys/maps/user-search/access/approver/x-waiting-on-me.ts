import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog x-waiting-on-me (access approver): req-0001 waits on Omar's manager step.
export default {
  family: 'user-search', log: 'access/approver-x-waiting-on-me', kind: 'intent', persona: P.omar, scenario: 'shared', identity: 'clone',
  goal: "See what waits on me from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/access/requests", "what is waiting on me", /req-0001/, /^\/access\/(approvals|requests\/req-0001)/),
  ],
} satisfies JourneyMap;

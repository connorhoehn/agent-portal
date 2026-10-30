import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { outbound, OUTBOUND_CLAIMS, OUTBOUND_PAGES, PERSONA } from '../_shared.ts';

export default {
  family: 'social', log: 'isolation/participant-outbound', kind: 'isolation-outbound', scenario: 'shared',
  persona: PERSONA['participant'],
  goal: 'A social participant holds no grant elsewhere: no orgiq or assessment link, route or API answers',
  fields: { pages: OUTBOUND_PAGES },
  claims: OUTBOUND_CLAIMS,
  steps: outbound(),
} satisfies JourneyMap;

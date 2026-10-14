import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { outbound, OUTBOUND_CLAIMS, ISOLATION_PAGES, REQUESTER } from '../_shared.ts';

export default {
  family: 'access', log: 'isolation/requester-outbound', kind: 'isolation-outbound', scenario: 'shared',
  persona: REQUESTER,
  goal: 'An access requester holds no grant elsewhere: no other tenant’s link, route or API answers',
  fields: { pages: ISOLATION_PAGES },
  claims: OUTBOUND_CLAIMS,
  steps: outbound(),
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { outbound, OUTBOUND_CLAIMS, ISOLATION_PAGES, APPROVER } from '../_shared.ts';

export default {
  family: 'access', log: 'isolation/approver-outbound', kind: 'isolation-outbound', scenario: 'shared',
  persona: APPROVER,
  goal: 'An access approver holds no grant elsewhere: no other tenant’s link, route or API answers',
  fields: { pages: ISOLATION_PAGES },
  claims: OUTBOUND_CLAIMS,
  steps: outbound(),
} satisfies JourneyMap;

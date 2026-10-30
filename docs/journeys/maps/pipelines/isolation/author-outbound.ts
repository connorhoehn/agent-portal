import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { outbound, OUTBOUND_CLAIMS, ISOLATION_PAGES, PERSONA } from '../_shared.ts';

export default {
  family: 'pipelines', log: 'isolation/author-outbound', kind: 'isolation-outbound', scenario: 'shared',
  persona: PERSONA['author'],
  goal: 'A pipelines author holds no grant elsewhere: no other tenant’s link, route or API answers',
  fields: { pages: ISOLATION_PAGES },
  claims: OUTBOUND_CLAIMS,
  steps: outbound(),
} satisfies JourneyMap;

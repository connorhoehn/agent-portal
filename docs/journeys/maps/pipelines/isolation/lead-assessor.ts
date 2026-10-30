import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'pipelines', log: 'isolation/lead-assessor', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-jonas', name: 'Jonas', tenant: 'assessment', role: 'lead-assessor', switchRole: true },
  goal: 'Jonas (assessment lead-assessor) holds no grant in Pipelines: no tile, no link, no route and no API answers, the events stream included',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/assessment/teams'),
} satisfies JourneyMap;

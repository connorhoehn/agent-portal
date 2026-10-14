import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'access', log: 'isolation/assessor', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-asha', name: 'Asha Nair', tenant: 'assessment', role: 'assessor' },
  goal: 'Asha (assessor) holds no grant in Access: no tile, no link, no route and no API answers',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/assessment/teams'),
} satisfies JourneyMap;

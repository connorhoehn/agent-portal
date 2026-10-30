import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'pipelines', log: 'isolation/assessor', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-asha', name: 'Asha', tenant: 'assessment', role: 'assessor' },
  goal: 'Asha (assessment assessor) holds no grant in Pipelines: no tile, no link, no route and no API answers, the events stream included',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/assessment/teams'),
} satisfies JourneyMap;

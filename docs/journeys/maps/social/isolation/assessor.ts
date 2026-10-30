import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, inboundClaims, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'social', log: 'isolation/assessor', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-asha', name: 'Asha Nair', tenant: 'assessment', role: 'assessor' },
  goal: 'Asha (assessment assessor) holds a social grant (a curated participant), yet standing in its own tenant reaches no Social link, route or API, and the bell carries nothing from a tenant it does not hold',
  fields: { pages: ISOLATION_PAGES },
  claims: inboundClaims(true),
  steps: inbound('/assessment/teams', true, ['/iq', '/admin', '/pipelines', '/access']),
} satisfies JourneyMap;

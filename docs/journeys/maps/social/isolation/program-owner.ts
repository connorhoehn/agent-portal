import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, inboundClaims, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'social', log: 'isolation/program-owner', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-mia', name: 'Mia Singh', tenant: 'orgiq', role: 'program-owner', switchRole: true },
  goal: 'Mia (orgiq program-owner) holds a social grant (a curated participant), yet standing in its own tenant reaches no Social link, route or API, and the bell carries nothing from a tenant it does not hold',
  fields: { pages: ISOLATION_PAGES },
  claims: inboundClaims(true),
  steps: inbound('/iq/projects', true, ['/assessment', '/pipelines', '/access']),
} satisfies JourneyMap;

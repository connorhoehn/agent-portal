import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, inboundClaims, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'social', log: 'isolation/org-leader', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-vera', name: 'Vera Green', tenant: 'orgiq', role: 'org-leader', switchRole: true },
  goal: 'Vera (orgiq org-leader) holds a social grant (a curated participant), yet standing in its own tenant reaches no Social link, route or API, and the bell carries nothing from a tenant it does not hold',
  fields: { pages: ISOLATION_PAGES },
  claims: inboundClaims(true),
  steps: inbound('/iq/projects', true, ['/assessment', '/pipelines']),
} satisfies JourneyMap;

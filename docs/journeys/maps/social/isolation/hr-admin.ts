import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, inboundClaims, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'social', log: 'isolation/hr-admin', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-hr', name: 'Helen Desai', tenant: 'orgiq', role: 'hr-admin' },
  goal: 'Helen (orgiq hr-admin) holds no social grant reaches no Social link, route or API, and the bell carries nothing from a tenant it does not hold',
  fields: { pages: ISOLATION_PAGES },
  claims: inboundClaims(false),
  steps: inbound('/iq/projects', false, ['/social', '/assessment', '/pipelines', '/access']),
} satisfies JourneyMap;

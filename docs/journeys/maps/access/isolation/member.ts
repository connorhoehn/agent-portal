import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'access', log: 'isolation/member', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-theo', name: 'Theo Chang', tenant: 'orgiq', role: 'member' },
  goal: 'Theo (orgiq member) holds no grant in Access: no tile, no link, no route and no API answers',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/iq/projects'),
} satisfies JourneyMap;

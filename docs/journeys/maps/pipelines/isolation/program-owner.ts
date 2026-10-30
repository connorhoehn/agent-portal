import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'pipelines', log: 'isolation/program-owner', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-mia', name: 'Mia', tenant: 'orgiq', role: 'program-owner', switchRole: true },
  goal: 'Mia (orgiq program-owner) holds no grant in Pipelines: no tile, no link, no route and no API answers, the events stream included',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/iq/projects'),
} satisfies JourneyMap;

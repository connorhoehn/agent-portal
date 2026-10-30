import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'pipelines', log: 'isolation/community-admin', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-mira', name: 'Mira Okafor', tenant: 'social', role: 'community-admin' },
  goal: 'Mira Okafor (social community-admin) holds no grant in Pipelines: no tile, no link, no route and no API answers, the events stream included',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/social/channels'),
} satisfies JourneyMap;

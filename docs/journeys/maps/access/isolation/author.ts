import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'access', log: 'isolation/author', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-ines', name: 'Ines Moreau', tenant: 'pipelines', role: 'author' },
  goal: 'Ines (pipelines author) holds no grant in Access: no tile, no link, no route and no API answers',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/pipelines/runs'),
} satisfies JourneyMap;

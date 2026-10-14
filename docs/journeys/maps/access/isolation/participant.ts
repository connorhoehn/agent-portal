import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { inbound, INBOUND_CLAIMS, ISOLATION_PAGES } from '../_shared.ts';

export default {
  family: 'access', log: 'isolation/participant', kind: 'isolation-inbound', scenario: 'shared',
  persona: { user: 'u-sana', name: 'Sana Iqbal', tenant: 'social', role: 'participant' },
  goal: 'Sana (social participant) holds no grant in Access: no tile, no link, no route and no API answers',
  fields: { pages: ISOLATION_PAGES },
  claims: INBOUND_CLAIMS,
  steps: inbound('/social/channels'),
} satisfies JourneyMap;

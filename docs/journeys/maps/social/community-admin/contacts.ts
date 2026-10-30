import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/contacts', kind: 'surface', persona: PERSONA['community-admin'], peers: { peer: PEER['community-admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('community-admin', 'contacts'),
  fields: { surface: 'contacts', pages: PAGES['contacts'] },
  claims: claims('contacts'),
  steps: SURFACES['contacts']('community-admin'),
} satisfies JourneyMap;

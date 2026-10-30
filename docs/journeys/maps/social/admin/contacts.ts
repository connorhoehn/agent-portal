import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/contacts', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER['admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('admin', 'contacts'),
  fields: { surface: 'contacts', pages: PAGES['contacts'] },
  claims: claims('contacts'),
  steps: SURFACES['contacts']('admin'),
} satisfies JourneyMap;

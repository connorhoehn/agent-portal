import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/contacts', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER['moderator'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('moderator', 'contacts'),
  fields: { surface: 'contacts', pages: PAGES['contacts'] },
  claims: claims('contacts'),
  steps: SURFACES['contacts']('moderator'),
} satisfies JourneyMap;

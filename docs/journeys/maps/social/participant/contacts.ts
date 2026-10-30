import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/contacts', kind: 'surface', persona: PERSONA['participant'], peers: { peer: PEER['participant'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('participant', 'contacts'),
  fields: { surface: 'contacts', pages: PAGES['contacts'] },
  claims: claims('contacts'),
  steps: SURFACES['contacts']('participant'),
} satisfies JourneyMap;

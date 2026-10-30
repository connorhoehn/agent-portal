import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/teams', kind: 'surface', persona: PERSONA['participant'], peers: { peer: PEER['participant'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('participant', 'teams'),
  fields: { surface: 'teams', pages: PAGES['teams'] },
  claims: claims('teams'),
  steps: SURFACES['teams']('participant'),
} satisfies JourneyMap;

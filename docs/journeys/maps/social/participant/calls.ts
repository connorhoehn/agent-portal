import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/calls', kind: 'surface', persona: PERSONA['participant'], peers: { peer: PEER['participant'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('participant', 'calls'),
  fields: { surface: 'calls', pages: PAGES['calls'] },
  claims: claims('calls'),
  steps: SURFACES['calls']('participant'),
} satisfies JourneyMap;

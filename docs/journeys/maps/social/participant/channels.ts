import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/channels', kind: 'surface', persona: PERSONA['participant'], peers: { peer: PEER['participant'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('participant', 'channels'),
  fields: { surface: 'channels', pages: PAGES['channels'] },
  claims: claims('channels'),
  steps: SURFACES['channels']('participant'),
} satisfies JourneyMap;

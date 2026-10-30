import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/calls', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER['moderator'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('moderator', 'calls'),
  fields: { surface: 'calls', pages: PAGES['calls'] },
  claims: claims('calls'),
  steps: SURFACES['calls']('moderator'),
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/channels', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER['moderator'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('moderator', 'channels'),
  fields: { surface: 'channels', pages: PAGES['channels'] },
  claims: claims('channels'),
  steps: SURFACES['channels']('moderator'),
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/dms', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER['moderator'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('moderator', 'dms'),
  fields: { surface: 'dms', pages: PAGES['dms'] },
  claims: claims('dms'),
  steps: SURFACES['dms']('moderator'),
} satisfies JourneyMap;

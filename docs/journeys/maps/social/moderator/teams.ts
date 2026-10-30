import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/teams', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER['moderator'] }, identityReason: PEER_REASON, scenario: 'shared',
  goal: goal('moderator', 'teams'),
  fields: { surface: 'teams', pages: PAGES['teams'] },
  claims: claims('teams'),
  steps: SURFACES['teams']('moderator'),
} satisfies JourneyMap;

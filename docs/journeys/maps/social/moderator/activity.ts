import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON, ACTIVITY_HOLD } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/activity', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER['moderator'] }, identityReason: PEER_REASON, scenario: 'shared',
  hold: ACTIVITY_HOLD,
  goal: goal('moderator', 'activity'),
  fields: { surface: 'activity', pages: PAGES['activity'] },
  claims: claims('activity'),
  steps: SURFACES['activity']('moderator'),
} satisfies JourneyMap;

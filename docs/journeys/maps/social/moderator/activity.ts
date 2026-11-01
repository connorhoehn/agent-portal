import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER_CLONE } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/activity', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER_CLONE['moderator'] }, identity: 'clone', scenario: { realtime: 'clone-dm' }, writes: true,
  goal: goal('moderator', 'activity'),
  fields: { surface: 'activity', pages: PAGES['activity'] },
  claims: claims('activity'),
  steps: SURFACES['activity']('moderator'),
} satisfies JourneyMap;

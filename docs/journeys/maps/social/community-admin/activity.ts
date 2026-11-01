import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER_CLONE } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/activity', kind: 'surface', persona: PERSONA['community-admin'], peers: { peer: PEER_CLONE['community-admin'] }, identity: 'clone', scenario: { realtime: 'clone-dm' }, writes: true,
  goal: goal('community-admin', 'activity'),
  fields: { surface: 'activity', pages: PAGES['activity'] },
  claims: claims('activity'),
  steps: SURFACES['activity']('community-admin'),
} satisfies JourneyMap;

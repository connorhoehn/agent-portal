import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER_CLONE } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/activity', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER_CLONE['admin'] }, identity: 'clone', scenario: { realtime: 'clone-dm' }, writes: true,
  goal: goal('admin', 'activity'),
  fields: { surface: 'activity', pages: PAGES['activity'] },
  claims: claims('activity'),
  steps: SURFACES['activity']('admin'),
} satisfies JourneyMap;

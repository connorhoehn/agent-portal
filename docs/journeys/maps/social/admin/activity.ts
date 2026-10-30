import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON, ACTIVITY_HOLD } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/activity', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER['admin'] }, identityReason: PEER_REASON, scenario: 'shared',
  hold: ACTIVITY_HOLD,
  goal: goal('admin', 'activity'),
  fields: { surface: 'activity', pages: PAGES['activity'] },
  claims: claims('activity'),
  steps: SURFACES['activity']('admin'),
} satisfies JourneyMap;

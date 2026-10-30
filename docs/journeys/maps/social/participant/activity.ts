import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER, PEER_REASON, ACTIVITY_HOLD } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/activity', kind: 'surface', persona: PERSONA['participant'], peers: { peer: PEER['participant'] }, identityReason: PEER_REASON, scenario: 'shared',
  hold: ACTIVITY_HOLD,
  goal: goal('participant', 'activity'),
  fields: { surface: 'activity', pages: PAGES['activity'] },
  claims: claims('activity'),
  steps: SURFACES['activity']('participant'),
} satisfies JourneyMap;

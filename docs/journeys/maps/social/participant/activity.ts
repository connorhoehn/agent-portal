import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER_CLONE } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/activity', kind: 'surface', persona: PERSONA['participant'], peers: { peer: PEER_CLONE['participant'] }, identity: 'clone', scenario: { realtime: 'clone-dm' }, writes: true,
  goal: goal('participant', 'activity'),
  fields: { surface: 'activity', pages: PAGES['activity'] },
  claims: claims('activity'),
  steps: SURFACES['activity']('participant'),
} satisfies JourneyMap;

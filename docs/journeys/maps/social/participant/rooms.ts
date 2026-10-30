import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER_CLONE } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/rooms', kind: 'surface', persona: PERSONA['participant'], peers: { peer: PEER_CLONE['participant'] }, identity: 'clone', scenario: { realtime: 'meeting' }, writes: true, media: 'meeting-fixture',
  goal: goal('participant', 'rooms'),
  fields: { surface: 'rooms', pages: PAGES['rooms'] },
  claims: claims('rooms'),
  steps: SURFACES['rooms']('participant'),
} satisfies JourneyMap;

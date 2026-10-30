import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER_CLONE } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/rooms', kind: 'surface', persona: PERSONA['moderator'], peers: { peer: PEER_CLONE['moderator'] }, identity: 'clone', scenario: { realtime: 'meeting' }, writes: true, media: 'meeting-fixture',
  goal: goal('moderator', 'rooms'),
  fields: { surface: 'rooms', pages: PAGES['rooms'] },
  claims: claims('rooms'),
  steps: SURFACES['rooms']('moderator'),
} satisfies JourneyMap;

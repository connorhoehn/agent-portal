import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims, PEER_CLONE } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/rooms', kind: 'surface', persona: PERSONA['admin'], peers: { peer: PEER_CLONE['admin'] }, identity: 'clone', scenario: { realtime: 'meeting' }, writes: true, media: 'meeting-fixture',
  goal: goal('admin', 'rooms'),
  fields: { surface: 'rooms', pages: PAGES['rooms'] },
  claims: claims('rooms'),
  steps: SURFACES['rooms']('admin'),
} satisfies JourneyMap;

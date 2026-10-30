import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/recordings', kind: 'surface', persona: PERSONA['community-admin'], scenario: 'shared',
  goal: goal('community-admin', 'recordings'),
  fields: { surface: 'recordings', pages: PAGES['recordings'] },
  claims: claims('recordings'),
  steps: SURFACES['recordings']('community-admin'),
} satisfies JourneyMap;

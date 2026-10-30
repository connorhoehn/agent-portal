import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/recordings', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'recordings'),
  fields: { surface: 'recordings', pages: PAGES['recordings'] },
  claims: claims('recordings'),
  steps: SURFACES['recordings']('admin'),
} satisfies JourneyMap;

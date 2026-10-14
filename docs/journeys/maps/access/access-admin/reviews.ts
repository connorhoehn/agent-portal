import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/reviews', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared',
  goal: GOALS['access-admin']['reviews'],
  fields: { surface: 'reviews', pages: PAGES['reviews'] },
  steps: SURFACES['reviews']('access-admin'),
} satisfies JourneyMap;

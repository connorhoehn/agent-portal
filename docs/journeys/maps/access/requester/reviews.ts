import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/reviews', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared',
  goal: GOALS['requester']['reviews'],
  fields: { surface: 'reviews', pages: PAGES['reviews'] },
  steps: SURFACES['reviews']('requester'),
} satisfies JourneyMap;

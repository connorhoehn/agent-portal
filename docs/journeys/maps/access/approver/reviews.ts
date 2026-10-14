import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/reviews', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared',
  goal: GOALS['approver']['reviews'],
  fields: { surface: 'reviews', pages: PAGES['reviews'] },
  steps: SURFACES['reviews']('approver'),
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'requester/configuration', kind: 'surface', persona: PERSONA['requester'], scenario: 'shared',
  goal: GOALS['requester']['configuration'],
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  steps: SURFACES['configuration']('requester'),
} satisfies JourneyMap;

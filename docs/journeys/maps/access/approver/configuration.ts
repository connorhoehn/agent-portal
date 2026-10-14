import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'approver/configuration', kind: 'surface', persona: PERSONA['approver'], scenario: 'shared',
  goal: GOALS['approver']['configuration'],
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  steps: SURFACES['configuration']('approver'),
} satisfies JourneyMap;

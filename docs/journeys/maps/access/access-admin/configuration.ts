import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/configuration', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared',
  goal: GOALS['access-admin']['configuration'],
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  steps: SURFACES['configuration']('access-admin'),
} satisfies JourneyMap;

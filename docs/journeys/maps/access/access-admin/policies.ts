import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/policies', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared',
  goal: GOALS['access-admin']['policies'],
  fields: { surface: 'policies', pages: PAGES['policies'] },
  steps: SURFACES['policies']('access-admin'),
} satisfies JourneyMap;

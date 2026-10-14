import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, GOALS, PERSONA } from '../_shared.ts';

export default {
  family: 'access', log: 'access-admin/audit', kind: 'surface', persona: PERSONA['access-admin'], scenario: 'shared',
  goal: GOALS['access-admin']['audit'],
  fields: { surface: 'audit', pages: PAGES['audit'] },
  steps: SURFACES['audit']('access-admin'),
} satisfies JourneyMap;

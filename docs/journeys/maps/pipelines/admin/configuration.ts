import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'configuration');
export default {
  family: 'pipelines', log: 'admin/configuration', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['configuration']('admin'),
} satisfies JourneyMap;

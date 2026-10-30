import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'admin/configuration', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  claims: claims('configuration'),
  steps: SURFACES['configuration']('admin'),
} satisfies JourneyMap;

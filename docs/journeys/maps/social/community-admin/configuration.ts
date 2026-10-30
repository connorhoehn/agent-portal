import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'community-admin/configuration', kind: 'surface', persona: PERSONA['community-admin'], scenario: 'shared',
  goal: goal('community-admin', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  claims: claims('configuration'),
  steps: SURFACES['configuration']('community-admin'),
} satisfies JourneyMap;

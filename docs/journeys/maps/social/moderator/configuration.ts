import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'moderator/configuration', kind: 'surface', persona: PERSONA['moderator'], scenario: 'shared',
  goal: goal('moderator', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  claims: claims('configuration'),
  steps: SURFACES['configuration']('moderator'),
} satisfies JourneyMap;

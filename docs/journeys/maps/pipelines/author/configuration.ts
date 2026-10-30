import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'configuration');
export default {
  family: 'pipelines', log: 'author/configuration', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['configuration']('author'),
} satisfies JourneyMap;

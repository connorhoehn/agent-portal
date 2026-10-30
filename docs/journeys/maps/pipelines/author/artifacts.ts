import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'artifacts');
export default {
  family: 'pipelines', log: 'author/artifacts', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'artifacts'),
  fields: { surface: 'artifacts', pages: PAGES['artifacts'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['artifacts']('author'),
} satisfies JourneyMap;

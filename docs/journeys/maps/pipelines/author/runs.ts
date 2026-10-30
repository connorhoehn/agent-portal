import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'runs');
export default {
  family: 'pipelines', log: 'author/runs', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'runs'),
  fields: { surface: 'runs', pages: PAGES['runs'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runs']('author'),
} satisfies JourneyMap;

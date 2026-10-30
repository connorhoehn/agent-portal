import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'definitions');
export default {
  family: 'pipelines', log: 'author/definitions', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'definitions'),
  fields: { surface: 'definitions', pages: PAGES['definitions'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['definitions']('author'),
} satisfies JourneyMap;

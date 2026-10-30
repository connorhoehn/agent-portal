import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'bots');
export default {
  family: 'pipelines', log: 'author/bots', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'bots'),
  fields: { surface: 'bots', pages: PAGES['bots'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['bots']('author'),
} satisfies JourneyMap;

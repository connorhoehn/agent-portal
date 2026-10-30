import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'runbooks');
export default {
  family: 'pipelines', log: 'author/runbooks', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'runbooks'),
  fields: { surface: 'runbooks', pages: PAGES['runbooks'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runbooks']('author'),
} satisfies JourneyMap;

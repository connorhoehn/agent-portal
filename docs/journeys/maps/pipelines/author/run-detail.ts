import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'run-detail');
export default {
  family: 'pipelines', log: 'author/run-detail', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'run-detail'),
  fields: { surface: 'run-detail', pages: PAGES['run-detail'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['run-detail']('author'),
} satisfies JourneyMap;

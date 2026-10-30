import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'agents');
export default {
  family: 'pipelines', log: 'author/agents', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'agents'),
  fields: { surface: 'agents', pages: PAGES['agents'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['agents']('author'),
} satisfies JourneyMap;

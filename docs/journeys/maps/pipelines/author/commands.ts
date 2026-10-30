import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('author', 'commands');
export default {
  family: 'pipelines', log: 'author/commands', kind: 'surface', persona: PERSONA['author'], scenario: 'shared',
  goal: goal('author', 'commands'),
  fields: { surface: 'commands', pages: PAGES['commands'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['commands']('author'),
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'bots');
export default {
  family: 'pipelines', log: 'operator/bots', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'bots'),
  fields: { surface: 'bots', pages: PAGES['bots'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['bots']('operator'),
} satisfies JourneyMap;

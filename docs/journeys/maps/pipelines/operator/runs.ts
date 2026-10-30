import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'runs');
export default {
  family: 'pipelines', log: 'operator/runs', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'runs'),
  fields: { surface: 'runs', pages: PAGES['runs'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runs']('operator'),
} satisfies JourneyMap;

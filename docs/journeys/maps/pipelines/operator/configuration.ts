import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'configuration');
export default {
  family: 'pipelines', log: 'operator/configuration', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['configuration']('operator'),
} satisfies JourneyMap;

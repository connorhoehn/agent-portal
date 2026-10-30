import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'artifacts');
export default {
  family: 'pipelines', log: 'operator/artifacts', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'artifacts'),
  fields: { surface: 'artifacts', pages: PAGES['artifacts'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['artifacts']('operator'),
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'definitions');
export default {
  family: 'pipelines', log: 'operator/definitions', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'definitions'),
  fields: { surface: 'definitions', pages: PAGES['definitions'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['definitions']('operator'),
} satisfies JourneyMap;

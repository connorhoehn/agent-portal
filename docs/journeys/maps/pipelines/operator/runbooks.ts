import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'runbooks');
export default {
  family: 'pipelines', log: 'operator/runbooks', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'runbooks'),
  fields: { surface: 'runbooks', pages: PAGES['runbooks'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runbooks']('operator'),
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'run-detail');
export default {
  family: 'pipelines', log: 'operator/run-detail', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'run-detail'),
  fields: { surface: 'run-detail', pages: PAGES['run-detail'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['run-detail']('operator'),
} satisfies JourneyMap;

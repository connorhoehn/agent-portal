import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'runs');
export default {
  family: 'pipelines', log: 'pipeline-admin/runs', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'runs'),
  fields: { surface: 'runs', pages: PAGES['runs'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runs']('pipeline-admin'),
} satisfies JourneyMap;

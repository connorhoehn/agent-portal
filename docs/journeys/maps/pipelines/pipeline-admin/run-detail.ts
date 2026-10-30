import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'run-detail');
export default {
  family: 'pipelines', log: 'pipeline-admin/run-detail', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'run-detail'),
  fields: { surface: 'run-detail', pages: PAGES['run-detail'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['run-detail']('pipeline-admin'),
} satisfies JourneyMap;

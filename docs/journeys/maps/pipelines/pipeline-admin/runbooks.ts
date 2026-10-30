import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'runbooks');
export default {
  family: 'pipelines', log: 'pipeline-admin/runbooks', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'runbooks'),
  fields: { surface: 'runbooks', pages: PAGES['runbooks'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['runbooks']('pipeline-admin'),
} satisfies JourneyMap;

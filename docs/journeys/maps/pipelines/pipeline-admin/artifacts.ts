import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'artifacts');
export default {
  family: 'pipelines', log: 'pipeline-admin/artifacts', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'artifacts'),
  fields: { surface: 'artifacts', pages: PAGES['artifacts'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['artifacts']('pipeline-admin'),
} satisfies JourneyMap;

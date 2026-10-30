import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'configuration');
export default {
  family: 'pipelines', log: 'pipeline-admin/configuration', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['configuration']('pipeline-admin'),
} satisfies JourneyMap;

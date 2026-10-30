import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'definitions');
export default {
  family: 'pipelines', log: 'pipeline-admin/definitions', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'definitions'),
  fields: { surface: 'definitions', pages: PAGES['definitions'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['definitions']('pipeline-admin'),
} satisfies JourneyMap;

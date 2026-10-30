import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'bots');
export default {
  family: 'pipelines', log: 'pipeline-admin/bots', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'bots'),
  fields: { surface: 'bots', pages: PAGES['bots'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['bots']('pipeline-admin'),
} satisfies JourneyMap;

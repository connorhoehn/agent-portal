import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('pipeline-admin', 'commands');
export default {
  family: 'pipelines', log: 'pipeline-admin/commands', kind: 'surface', persona: PERSONA['pipeline-admin'], scenario: 'shared',
  goal: goal('pipeline-admin', 'commands'),
  fields: { surface: 'commands', pages: PAGES['commands'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['commands']('pipeline-admin'),
} satisfies JourneyMap;

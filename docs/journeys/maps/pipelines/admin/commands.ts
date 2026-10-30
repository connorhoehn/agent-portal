import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'commands');
export default {
  family: 'pipelines', log: 'admin/commands', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'commands'),
  fields: { surface: 'commands', pages: PAGES['commands'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['commands']('admin'),
} satisfies JourneyMap;

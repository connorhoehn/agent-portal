import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('operator', 'commands');
export default {
  family: 'pipelines', log: 'operator/commands', kind: 'surface', persona: PERSONA['operator'], scenario: 'shared',
  goal: goal('operator', 'commands'),
  fields: { surface: 'commands', pages: PAGES['commands'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['commands']('operator'),
} satisfies JourneyMap;

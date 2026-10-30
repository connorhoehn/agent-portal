import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'bots');
export default {
  family: 'pipelines', log: 'admin/bots', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'bots'),
  fields: { surface: 'bots', pages: PAGES['bots'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['bots']('admin'),
} satisfies JourneyMap;

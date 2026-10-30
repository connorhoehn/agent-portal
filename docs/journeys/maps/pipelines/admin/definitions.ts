import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

const claimed = claims('admin', 'definitions');
export default {
  family: 'pipelines', log: 'admin/definitions', kind: 'surface', persona: PERSONA['admin'], scenario: 'shared',
  goal: goal('admin', 'definitions'),
  fields: { surface: 'definitions', pages: PAGES['definitions'] },
  ...(claimed ? { claims: claimed } : {}),
  steps: SURFACES['definitions']('admin'),
} satisfies JourneyMap;

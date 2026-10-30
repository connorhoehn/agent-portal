import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/recordings', kind: 'surface', persona: PERSONA['participant'], scenario: 'shared',
  goal: goal('participant', 'recordings'),
  fields: { surface: 'recordings', pages: PAGES['recordings'] },
  claims: claims('recordings'),
  steps: SURFACES['recordings']('participant'),
} satisfies JourneyMap;

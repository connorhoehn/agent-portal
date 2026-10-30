import type { JourneyMap } from '../../../../../scripts/journeys/journey-map.ts';
import { SURFACES, PAGES, PERSONA, goal, claims } from '../_shared.ts';

export default {
  family: 'social', log: 'participant/configuration', kind: 'surface', persona: PERSONA['participant'], scenario: 'shared',
  goal: goal('participant', 'configuration'),
  fields: { surface: 'configuration', pages: PAGES['configuration'] },
  claims: claims('configuration'),
  steps: SURFACES['configuration']('participant'),
} satisfies JourneyMap;

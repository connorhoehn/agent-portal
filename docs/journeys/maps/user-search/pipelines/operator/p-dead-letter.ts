import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, firstRowLink, palette, listSearch, composer } from '../../_shared.ts';

// Catalog p-dead-letter (pipelines operator): the compaction DLQ.
export default {
  family: 'user-search', log: 'pipelines/operator-p-dead-letter', kind: 'intent', persona: P.kofi, scenario: 'shared', identity: 'clone',
  goal: "Find the dead-letter queue",
  fields: { surface: "list command composer", pages: "portal/src/pages/pipelines" },
  steps: [
    ...composer("/pipelines/queues", "show dead-letter queues", [/Dead-letter queue/]),
    open(firstRowLink('pipeline-queues-table'), /^\/pipelines\/queues\?queue=/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

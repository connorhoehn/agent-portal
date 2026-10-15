import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog p-bot-last-run (pipelines pipeline-admin): finops-daily-sweep's last run.
export default {
  family: 'user-search', log: 'pipelines/pipeline-admin-p-bot-last-run', kind: 'intent', persona: P.dara, scenario: 'shared', identity: 'clone',
  goal: "See when finops-daily-sweep last ran",
  fields: { surface: "list search", pages: "portal/src/pages/pipelines" },
  hold: HOLD.tenantSearch,
  steps: [
    ...listSearch("/pipelines/bots", "Search bots", "finops", [/finops/]),
    open(link(/finops/), /^\/pipelines\/bots/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

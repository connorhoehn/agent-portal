import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog p-failed-runs (pipelines operator): the failed runs across workspaces.
export default {
  family: 'user-search', log: 'pipelines/operator-p-failed-runs', kind: 'intent', persona: P.kofi, scenario: 'shared', identity: 'clone',
  goal: "See which runs failed",
  fields: { surface: "list command composer", pages: "portal/src/components/runs" },
  steps: [
    ...composer("/pipelines/runs", "show failed runs", [/token verifier|JWKS|comp-104|confluence|self-assessment/]),
    open(link(/token verifier|JWKS|comp-104/), /^\/pipelines\/runs\//, 'The row opens its record'),
  ],
} satisfies JourneyMap;

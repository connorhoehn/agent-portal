import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog p-needs-dry-run (pipelines author): promo-custodian-sg-drift.
export default {
  family: 'user-search', log: 'pipelines/author-p-needs-dry-run', kind: 'intent', persona: P.ines, scenario: 'shared', identity: 'clone',
  goal: "Find runbooks that still need a dry run",
  fields: { surface: "list command composer", pages: "portal/src/pages/pipelines" },
  hold: HOLD.tenantSearch,
  steps: [
    ...composer("/pipelines/runbooks", "show needs dry-run runbooks", [/Custodian|security-group/]),
    open(link(/Custodian|security-group/), /^\/pipelines\/runbooks/, 'The row opens its record'),
  ],
} satisfies JourneyMap;

import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, firstRowLink, palette, listSearch, composer } from '../../_shared.ts';

// Catalog p-needs-dry-run (pipelines author): promo-custodian-sg-drift.
export default {
  family: 'user-search', log: 'pipelines/author-p-needs-dry-run', kind: 'intent', persona: P.ines, scenario: 'shared', identity: 'clone',
  goal: "Find runbooks that still need a dry run",
  fields: { surface: "list command composer", pages: "portal/src/pages/pipelines" },
  steps: [
    ...composer("/pipelines/runbooks", "show needs dry-run runbooks", [/Needs a completed dry-run/]),
    open(firstRowLink('pipelines-runbooks-table'), /^\/pipelines\/definitions\//, 'The row opens its record'),
  ],
} satisfies JourneyMap;

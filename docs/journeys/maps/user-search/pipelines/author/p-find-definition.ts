import type { JourneyMap } from '../../../../../../scripts/journeys/journey-map.ts';
import { P, HOLD, open, link, palette, listSearch, composer } from '../../_shared.ts';

// Catalog p-find-definition (pipelines author): a definition by name.
export default {
  family: 'user-search', log: 'pipelines/author-p-find-definition', kind: 'intent', persona: P.ines, scenario: 'shared', identity: 'clone',
  goal: "Jump to a pipeline definition from the palette",
  fields: { surface: "palette record jump", pages: "portal/src/components/shell/portalCommands.ts" },
  hold: HOLD.palette,
  steps: [
    ...palette("/pipelines/runs", "obs-nightly-maintenance", /nightly/, /^\/pipelines\/definitions\//),
  ],
} satisfies JourneyMap;

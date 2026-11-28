// Orgiq initiative status decks under MOCK_AURORA (docs/agentic-flows-migration.md
// slice 6). Rows mirror schema/initiative_deck_schema.sql. No stored spec is
// seeded: a stored copy of an initiative's numbers could disagree with its
// rows. The default scenario carries the four sample decks of
// ./sample-decks.ts instead, which are BUILT from the rows each time the
// fixture is read, so their numbers are the rows' own. The empty scenario is
// empty. POST /api/__mock/reset puts the samples back and clears every other deck.

import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { defineFixture } from './core/fixture.js';
import { buildSampleDeck, sampleDeckId, sampleRevisionId, SAMPLE_INITIATIVE_DECKS, SAMPLE_SUMMARY } from './sample-decks.js';

export interface InitiativeDeckRow {
  id: string;
  projectId: string;
  title: string;
  /** True when the deck carries allocation/spend/envelope/maintenance figures.
      Only a budget-tier reader may open it (providers/initiative-decks.ts). */
  includesBudget: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The newest revision — the CAS anchor every save names as its base. */
  headRevisionId: string | null;
}

export interface InitiativeDeckRevisionRow {
  id: string;
  deckId: string;
  seq: number;
  baseRevisionId: string | null;
  label: string;
  spec: DeckSpec;
  lockedSlideIds: string[];
  /** 'generated' for the facts deck, `person:<sub>` for a person's edit. */
  producedBy: string;
  createdBy: string | null;
  summary: string | null;
  createdAt: string;
}

export const initiativeDecksFixture = defineFixture<InitiativeDeckRow>({
  key: 'orgiq.decks',
  scenarios: {
    default: () => SAMPLE_INITIATIVE_DECKS.map(({ key, projectId, n }) => {
      const d = buildSampleDeck(key, n);
      return { id: sampleDeckId('idk', n), projectId, title: d.spec.title, includesBudget: false, createdBy: null, createdAt: d.createdAt, updatedAt: d.createdAt, headRevisionId: sampleRevisionId('irev', n) };
    }),
    empty: () => [],
  },
});

export const initiativeDeckRevisionsFixture = defineFixture<InitiativeDeckRevisionRow>({
  key: 'orgiq.deck-revisions',
  scenarios: {
    default: () => SAMPLE_INITIATIVE_DECKS.map(({ key, n }) => {
      const d = buildSampleDeck(key, n);
      return { id: sampleRevisionId('irev', n), deckId: sampleDeckId('idk', n), seq: 1, baseRevisionId: null, label: 'Sample deck', spec: d.spec, lockedSlideIds: [], producedBy: `sample:${key}`, createdBy: null, summary: SAMPLE_SUMMARY, createdAt: d.createdAt };
    }),
    empty: () => [],
  },
});

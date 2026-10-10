// Orgiq initiative status decks under MOCK_AURORA (docs/agentic-flows-migration.md
// slice 6). Rows mirror schema/initiative_deck_schema.sql. Seeded empty on
// purpose: a deck's slides are facts read from the initiative's own rows
// (the seed_program.sql cast: work items, sprints, grants, bot runs) at
// generation time, so a seeded spec would be a second copy of numbers that
// could disagree with them. POST /api/__mock/reset clears every deck.

import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { defineFixture } from './core/fixture.js';

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
  scenarios: { default: () => [], empty: () => [] },
});

export const initiativeDeckRevisionsFixture = defineFixture<InitiativeDeckRevisionRow>({
  key: 'orgiq.deck-revisions',
  scenarios: { default: () => [], empty: () => [] },
});

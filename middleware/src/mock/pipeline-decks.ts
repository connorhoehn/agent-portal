// Pipeline run report decks under MOCK_AURORA (docs/agentic-flows-migration.md
// slice 3). Rows mirror schema/pipeline_deck_schema.sql. Seeded empty on
// purpose: a deck's slides are facts read from the run projection at
// generation time, so a seeded spec would be a second copy of numbers that
// could disagree with the run. POST /api/__mock/reset clears every deck.

import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { defineFixture } from './core/fixture.js';

export interface PipelineDeckRow {
  id: string;
  runId: string;
  title: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The newest revision — the CAS anchor every save names as its base. */
  headRevisionId: string | null;
}

export interface PipelineDeckRevisionRow {
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

export const pipelineDecksFixture = defineFixture<PipelineDeckRow>({
  key: 'pipelines.decks',
  scenarios: { default: () => [], empty: () => [] },
});

export const pipelineDeckRevisionsFixture = defineFixture<PipelineDeckRevisionRow>({
  key: 'pipelines.deck-revisions',
  scenarios: { default: () => [], empty: () => [] },
});

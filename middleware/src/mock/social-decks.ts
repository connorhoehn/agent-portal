// Social /deck decks under MOCK_AURORA (docs/agentic-flows-migration.md slice
// 5). Rows mirror schema/social_deck_schema.sql. Seeded empty on purpose: a
// deck's slides are counted from the requester's own conversation at build
// time, so a seeded spec would be a second copy that could disagree with the
// thread. POST /api/__mock/reset clears every deck.

import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import { defineFixture } from './core/fixture.js';

export interface SocialDeckRow {
  id: string;
  /** The conversation the deck was built from. */
  channel: string;
  runId: string | null;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  headRevisionId: string | null;
}

export interface SocialDeckRevisionRow {
  id: string;
  deckId: string;
  seq: number;
  baseRevisionId: string | null;
  label: string;
  spec: DeckSpec;
  lockedSlideIds: string[];
  producedBy: string;
  createdBy: string | null;
  summary: string | null;
  createdAt: string;
}

export const socialDecksFixture = defineFixture<SocialDeckRow>({
  key: 'social.decks',
  scenarios: { default: () => [], empty: () => [] },
});

export const socialDeckRevisionsFixture = defineFixture<SocialDeckRevisionRow>({
  key: 'social.deck-revisions',
  scenarios: { default: () => [], empty: () => [] },
});

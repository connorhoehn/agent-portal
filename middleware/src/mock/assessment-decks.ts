// Assessment review decks under MOCK_AURORA (docs/assessment-deck-goal.md,
// "Storage"). Rows mirror schema/assessment_deck_schema.sql. The seed is
// empty on purpose: a deck's slides are facts read from the assessment
// fixtures at generation time, so a seeded spec would be a second copy of
// numbers that could disagree with the scorecard. POST /api/__mock/reset
// clears every deck and revision created during a session.

import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { defineFixture } from './core/fixture.js';

export interface AssessmentDeckRow {
  id: string;
  teamId: string;
  title: string;
  audience: string | null;
  dimensionIds: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The newest revision — the CAS anchor every save names as its base. */
  headRevisionId: string | null;
  /** The most recent generation/revise run launched for this deck. */
  lastRunId: string | null;
}

export interface AssessmentDeckRevisionRow {
  id: string;
  deckId: string;
  seq: number;
  baseRevisionId: string | null;
  label: string;
  spec: DeckSpec;
  lockedSlideIds: string[];
  /** The run id for an agent revision, `person:<sub>` for a person's edit. */
  producedBy: string;
  createdBy: string | null;
  summary: string | null;
  createdAt: string;
}

export const assessmentDecksFixture = defineFixture<AssessmentDeckRow>({
  key: 'assessment.decks',
  scenarios: { default: () => [], empty: () => [] },
});

export const assessmentDeckRevisionsFixture = defineFixture<AssessmentDeckRevisionRow>({
  key: 'assessment.deck-revisions',
  scenarios: { default: () => [], empty: () => [] },
});

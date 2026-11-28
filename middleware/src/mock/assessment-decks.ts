// Assessment review decks under MOCK_AURORA (docs/assessment-deck-goal.md,
// "Storage"). Rows mirror schema/assessment_deck_schema.sql. No stored spec
// is seeded: a stored copy could disagree with the scorecard. The default
// scenario carries one sample readout from ./sample-decks.ts, BUILT from the
// scores each time the fixture is read. The empty scenario is empty.
// POST /api/__mock/reset puts the sample back and clears every other deck.

import type { DeckSpec } from '@connorhoehn/realtime-modules/deck';
import { defineFixture } from './core/fixture.js';
import { buildSampleDeck, sampleDeckId, sampleRevisionId, SAMPLE_ASSESSMENT_DECKS, SAMPLE_SUMMARY } from './sample-decks.js';

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
  scenarios: {
    default: () => SAMPLE_ASSESSMENT_DECKS.map(({ key, teamId, n }) => {
      const d = buildSampleDeck(key, n);
      return { id: sampleDeckId('deck', n), teamId, title: d.spec.title, audience: 'The team and its assessment lead', dimensionIds: [], createdBy: null, createdAt: d.createdAt, updatedAt: d.createdAt, headRevisionId: sampleRevisionId('rev', n), lastRunId: null };
    }),
    empty: () => [],
  },
});

export const assessmentDeckRevisionsFixture = defineFixture<AssessmentDeckRevisionRow>({
  key: 'assessment.deck-revisions',
  scenarios: {
    default: () => SAMPLE_ASSESSMENT_DECKS.map(({ key, n }) => {
      const d = buildSampleDeck(key, n);
      return { id: sampleRevisionId('rev', n), deckId: sampleDeckId('deck', n), seq: 1, baseRevisionId: null, label: 'Sample deck', spec: d.spec, lockedSlideIds: [], producedBy: `sample:${key}`, createdBy: null, summary: SAMPLE_SUMMARY, createdAt: d.createdAt };
    }),
    empty: () => [],
  },
});

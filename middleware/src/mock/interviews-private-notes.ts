// The private notes and scorecard drafts fixtures (gap audit 2026-11-20, section 5): the mock world's
// interview_private_notes and interview_scorecard_drafts tables. None in the seed: a note and a draft are written on
// purpose by the person they belong to, and nobody else may read them, so a seeded one would be words nobody wrote.
// Registered from this module (lib/interviews/store.ts imports it). `POST /api/__mock/reset` restores them.
import { defineFixture } from './core/index.js';
import type { PrivateNote, ScorecardDraft } from '../lib/interviews/private-notes.js';

export const interviewPrivateNotesFixture = defineFixture<PrivateNote>({
  key: 'interviews.private-notes',
  scenarios: { default: () => [], empty: () => [] },
});

export const interviewScorecardDraftsFixture = defineFixture<ScorecardDraft>({
  key: 'interviews.scorecard-drafts',
  scenarios: { default: () => [], empty: () => [] },
});

// The command composer's grammar for each interviews collection page — the one
// bounded grammar (components/collections/collectionCommands.ts): search, at
// most one existing filter, reset and refresh over the rows shown. Phase 0 has
// no writes and no record pages, so there is no `open` and nothing here
// accepts, assigns, schedules or decides anything.

import { collectionCommandAdapter, type CollectionControls, type CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';

export type InterviewsCollection = 'candidates' | 'my-interviews' | 'my-openings';

/** Explicit phrase → the toolbar filter value it sets (never a mutation). */
export const INTERVIEWS_GRAMMARS: Readonly<Record<InterviewsCollection, CollectionGrammar>> = {
  candidates: { noun: 'candidates', filters: { applied: 'applied', screening: 'screening', interviewing: 'interviewing', debrief: 'debrief', 'on hold': 'on-hold' } },
  'my-interviews': { noun: 'interviews', filters: { 'to accept': 'to-accept', upcoming: 'upcoming', 'scorecards due': 'scorecard-due', done: 'done' } },
  'my-openings': { noun: 'candidates', filters: { applied: 'applied', screening: 'screening', interviewing: 'interviewing', debrief: 'debrief' } },
};

/** What each page's help popover says the commands touch, and never do. */
export const INTERVIEWS_SCOPE_NOTES: Readonly<Record<InterviewsCollection, string>> = {
  candidates: 'Search and the stage filter apply to the loaded candidates. Commands never move a candidate, assign an interview or contact anyone.',
  'my-interviews': 'Search and the desk filter apply to the interviews assigned to you. Commands never accept, decline or score an interview.',
  'my-openings': 'Search and the stage filter apply to the candidates on your openings. Commands never decide a candidate\'s stage.',
};

export function interviewsCollectionAdapter(collection: InterviewsCollection, controls: Omit<CollectionControls, 'scopeNote' | 'id'>): CollectionCommandAdapter {
  return collectionCommandAdapter(INTERVIEWS_GRAMMARS[collection], {
    ...controls,
    id: `interviews-${collection}-commands`,
    scopeNote: INTERVIEWS_SCOPE_NOTES[collection],
  });
}

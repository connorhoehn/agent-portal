// Typed client for the orgiq initiative status deck routes
// (docs/agentic-flows-migration.md slice 6, all under /api/initiative-decks).
// Pages and hooks never build these URLs themselves. Types and the error
// classes are the assessment deck client's (same wire shapes); only the paths
// and the `includesBudget` flag differ. Free of runtime React imports so
// `node --test` can load it.

import {
  deckPost, makeDeckApi, makeNarrativeNotice,
  type DeckDetailCore, type DeckRevisionInfo, type DeckSpec, type NarrativeOutcome,
} from '../../../components/decks/deckApi.ts';

export type { DeckSpec, NarrativeOutcome };

const BASE = '/api/initiative-decks';

export interface InitiativeDeckDetail extends DeckDetailCore {
  projectId: string;
  /** True when the deck carries allocation/spend/envelope/maintenance figures. */
  includesBudget: boolean;
}

export interface InitiativeDeckSummary {
  id: string; projectId: string; title: string; includesBudget: boolean; latestRevision: DeckRevisionInfo | null; updatedAt: string;
}

export interface CreatedInitiativeDeck { deckId: string; revisionId: string; includesBudget: boolean; narrative: NarrativeOutcome }

const api = makeDeckApi<InitiativeDeckDetail>({ tenant: 'orgiq', base: BASE, decksPath: '', listParam: 'projectId', revise: true });

export const initiativeDeckPaths = {
  create: (projectId: string) => `${BASE}/projects/${encodeURIComponent(projectId)}`,
  ...api.paths,
  page: (deckId: string) => `/iq/decks/${encodeURIComponent(deckId)}`,
} as const;

export const createInitiativeDeck = (projectId: string, input: { title?: string; narrative?: boolean; includeBudget?: boolean }): Promise<CreatedInitiativeDeck> =>
  deckPost(initiativeDeckPaths.create(projectId), input);
export const getInitiativeDeck = api.getDeck;
export const getInitiativeDeckSpec = api.getRevisionSpec;
export const previewInitiativeDeck = api.previewDeck;
/** Person edit. Rejects with `DeckRevisionConflictError` when `baseRevisionId` is stale. */
export const saveInitiativeDeckRevision = api.saveRevision;
/** Agent revise (DispatchAgentRun): answered in the request; see `DeckReviseResult`. */
export const reviseInitiativeDeck = api.reviseDeck;

export const narrativeNotice = makeNarrativeNotice('initiative record');

/** Why Share to Social is withheld for a deck, or null when it may be offered. */
export function shareWithheldReason(deck: Pick<InitiativeDeckDetail, 'includesBudget'>): string | null {
  return deck.includesBudget
    ? 'This deck carries budget figures, so it cannot be shared to a channel. Build one without budget figures to share it.'
    : null;
}

// What the initiative page's Status deck dialog offers. Pure so the three
// states (reader/no deck, reader/with deck, builder/no deck) are testable.
export type StatusDeckDialogState = {
  showBuild: boolean;          // Build form + footer button (DispatchAgentRun only)
  primary: 'build' | 'open' | 'none';
  notice: string | null;       // honest read-only voice for viewers who cannot build
  emptyText: string | null;
};
export function statusDeckDialogState(input: { canBuild: boolean; deckCount: number; projectName: string }): StatusDeckDialogState {
  const { canBuild, deckCount, projectName } = input;
  const notice = canBuild ? null : 'Your role can read status decks but not build one — an SME or program owner can.';
  const emptyText = deckCount > 0 ? null : canBuild
    ? `No status deck for ${projectName} yet. Every number in one comes from the initiative record.`
    : `No status deck for ${projectName} has been built yet.`;
  return { showBuild: canBuild, primary: canBuild ? 'build' : deckCount > 0 ? 'open' : 'none', notice, emptyText };
}

// Typed client for the assessment review-deck routes (docs/assessment-deck-goal.md
// "API"). Every route under /api/assessment is one function here; pages and
// hooks never build these URLs themselves.
//
// Deliberately free of runtime imports so `node --test` can load it: the spec
// and preview types come from the library as type-only imports.

import {
  DeckApiError, DeckRevisionConflictError, deckCall, deckPost, makeDeckApi,
  type DeckDetailCore, type DeckPendingRun, type DeckPreviewResult, type DeckPreviewSlide, type DeckRevisionInfo, type DeckRunRef,
  type DeckRunState, type DeckSpec,
} from '../../../components/decks/deckApi.ts';

export { DeckApiError, DeckRevisionConflictError };
export type { DeckSpec, DeckRevisionInfo, DeckRunRef, DeckPendingRun, DeckRunState, DeckPreviewResult, DeckPreviewSlide };

const BASE = '/api/assessment';

export interface DeckSummary {
  id: string;
  teamId: string;
  title: string;
  latestRevision: DeckRevisionInfo | null;
  updatedAt: string;
}

export interface DeckDetail extends DeckDetailCore {
  teamId: string;
  audience?: string | null;
}

export interface CreateDeckInput {
  title?: string;
  dimensionIds?: string[];
  audience?: string;
}

const api = makeDeckApi<DeckDetail>({ tenant: 'assessment', base: BASE, decksPath: '/decks', listParam: 'teamId' });

export const deckPaths = {
  teamDecks: (teamId: string) => `${BASE}/teams/${encodeURIComponent(teamId)}/decks`,
  ...api.paths,
  revise: (deckId: string) => `${BASE}/decks/${encodeURIComponent(deckId)}/revise`,
  run: (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}`,
} as const;

export function createDeck(teamId: string, input: CreateDeckInput): Promise<{ deckId: string; runId: string }> {
  return deckPost(deckPaths.teamDecks(teamId), input);
}

export function listDecks(teamId?: string, signal?: AbortSignal): Promise<DeckSummary[]> {
  return deckCall(deckPaths.list(teamId), signal ? { signal } : {});
}

export const getDeck = api.getDeck;
export const getRevisionSpec = api.getRevisionSpec;
/** Person edit. Rejects with `DeckRevisionConflictError` when `baseRevisionId` is stale. */
export const saveRevision = api.saveRevision;
export const previewDeck = api.previewDeck;

export function reviseDeck(
  deckId: string,
  input: { instruction: string; slideId?: string; baseRevisionId: string },
): Promise<{ runId: string }> {
  return deckPost(deckPaths.revise(deckId), input);
}

export function getRun(runId: string, signal?: AbortSignal): Promise<DeckRunState> {
  return deckCall(deckPaths.run(runId), signal ? { signal } : {});
}

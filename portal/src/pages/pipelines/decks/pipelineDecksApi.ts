// Typed client for the pipelines run report deck routes
// (docs/agentic-flows-migration.md slice 3, all under /api/pipelines). Pages
// and hooks never build these URLs themselves. Types and the error classes
// are the assessment deck client's (same wire shapes); only the paths differ.
// Free of runtime React imports so `node --test` can load it.

import {
  deckCall, deckPost, makeDeckApi, makeNarrativeNotice,
  type DeckDetailCore, type DeckRevisionInfo, type DeckRunState, type DeckSpec, type NarrativeOutcome,
} from '../../../components/decks/deckApi.ts';

export type { DeckSpec, NarrativeOutcome };

const BASE = '/api/pipelines';

export interface RunDeckDetail extends DeckDetailCore {
  runId: string;
}

export interface RunDeckSummary {
  id: string; runId: string; title: string; latestRevision: DeckRevisionInfo | null; updatedAt: string;
}

export interface CreatedRunDeck { deckId: string; revisionId: string; narrative: NarrativeOutcome }

const api = makeDeckApi<RunDeckDetail>({ tenant: 'pipelines', base: BASE, decksPath: '/decks', listParam: 'runId' });

export const runDeckPaths = {
  create: (runId: string) => `${BASE}/runs/${encodeURIComponent(runId)}/decks`,
  ...api.paths,
  revise: (deckId: string) => `${BASE}/decks/${encodeURIComponent(deckId)}/revise`,
  run: (deckId: string, runId: string) => `${BASE}/decks/${encodeURIComponent(deckId)}/runs/${encodeURIComponent(runId)}`,
  page: (deckId: string) => `/pipelines/decks/${encodeURIComponent(deckId)}`,
} as const;

export const createRunDeck = (runId: string, input: { title?: string; narrative?: boolean }): Promise<CreatedRunDeck> => deckPost(runDeckPaths.create(runId), input);
export const getRunDeck = api.getDeck;
export const getRunDeckSpec = api.getRevisionSpec;
export const previewRunDeck = api.previewDeck;
/** Person edit. Rejects with `DeckRevisionConflictError` when `baseRevisionId` is stale. */
export const saveRunDeckRevision = api.saveRevision;

/**
 * Asks the agent to revise the saved version: 202 { runId }, a requester-private
 * flow run (`pdr-…`). Rejects with `DeckRevisionConflictError` when
 * `baseRevisionId` is no longer the newest; a locked slide is a plain DeckApiError (409).
 */
export const reviseRunDeck = (
  deckId: string, input: { instruction: string; slideId?: string; baseRevisionId: string },
): Promise<{ runId: string }> => deckPost(runDeckPaths.revise(deckId), input);

/** One of the caller's own revise runs of this deck (anyone else's is a 404). */
export const getReviseRun = (deckId: string, runId: string, signal?: AbortSignal): Promise<DeckRunState> =>
  deckCall(runDeckPaths.run(deckId, runId), signal ? { signal } : {});

export const narrativeNotice = makeNarrativeNotice('run record');

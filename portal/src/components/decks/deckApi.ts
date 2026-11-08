// The deck API client every tenant shares (assessment review decks, orgiq
// initiative decks, pipeline run decks, social /deck decks). The wire shapes
// and the routes are the same four times over; only the base path, the list
// filter and the create/revise routes differ, so a tenant file is now a
// `makeDeckApi({ base, ... })` call plus its own extras.
//
// Deliberately free of runtime imports so `node --test` can load it: the spec
// type comes from the library as a type-only import.

import type { DeckSpec } from '@connorhoehn/ui-components/doc-editor';

export type { DeckSpec };

export interface DeckRevisionInfo {
  id: string;
  label: string;
  createdAt: string;
  /** The run that wrote it, or a person's id/name for a hand save. */
  producedBy: string;
  /** An archived version whose metadata survived but whose body did not. */
  specAvailable?: false;
  unavailabilityReason?: string;
}

/** pendingRun / lastRun on the deck detail: the run's state as the server last saw it. */
export interface DeckRunRef {
  runId: string;
  command: string;
  status: 'running' | 'completed' | 'failed' | string;
  summary: string;
  error: string | null;
}
export type DeckPendingRun = DeckRunRef;

/** The slice of an assessment run record the deck pages read. */
export interface DeckRunState {
  id: string;
  status: 'running' | 'completed' | 'failed' | string;
  summary?: string | null;
  error?: string | null;
  progress?: { phase?: string; detail?: string } | null;
  /** Pipelines revise runs name what they changed; assessment's do not. */
  changedSlideIds?: string[];
}

/** What every tenant's deck detail carries (the tenant adds its subject: teamId, runId, ...). */
export interface DeckDetailCore {
  id: string;
  title: string;
  /** Newest first. */
  revisions: DeckRevisionInfo[];
  activeRevisionId: string | null;
  lockedSlideIds?: string[];
  /** Present only while a generation/revise run for this deck is running. */
  pendingRun?: DeckRunRef | null;
  /** The most recent run whatever its outcome, so a failure can be shown. */
  lastRun?: DeckRunRef | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The answer of a synchronous agent revise (`POST /decks/:id/revise` on orgiq
 * and Social decks): 201 when a revision was written, 200 when the same
 * `requestId` is replayed or the edit changed nothing (`revisionId: null`).
 */
export interface DeckReviseResult {
  revisionId: string | null;
  summary: string;
  changedSlideIds: string[];
  engine: 'agent' | 'fallback' | 'offline';
  replayed: boolean;
}

export interface DeckPreviewSlide {
  id: string;
  svg: string;
  title?: string;
  generated?: boolean;
}

export interface DeckPreviewResult {
  slides: DeckPreviewSlide[];
  warnings: string[];
}

export interface NarrativeOutcome {
  requested: boolean;
  /** none: not asked · applied: every narrative slide used prose · partial: some kept the template · fallback: all template · unavailable: no agent reachable */
  status: 'none' | 'applied' | 'partial' | 'fallback' | 'unavailable';
  templatedSlideIds: string[];
  reason?: string;
}

/** Any non-2xx. `status` lets a caller branch; `message` is the server's own words. */
export class DeckApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DeckApiError';
    this.status = status;
  }
}

/**
 * A save or an agent revision named a base revision that is no longer the
 * newest: 409 `{ error, activeRevisionId }`. (A locked-slide 409 has no
 * activeRevisionId and stays a plain DeckApiError.)
 */
export class DeckRevisionConflictError extends DeckApiError {
  activeRevisionId: string | null;
  constructor(message = 'A newer version of this deck exists.', activeRevisionId: string | null = null) {
    super(409, message);
    this.name = 'DeckRevisionConflictError';
    this.activeRevisionId = activeRevisionId;
  }
}

export type Fetch = typeof fetch;

/** The server's `{ error, errors?[], activeRevisionId? }` body, read defensively. */
async function errorBody(res: Response): Promise<{ message: string; activeRevisionId?: string }> {
  let message = res.status === 403 ? 'You do not have permission for this action.' : `HTTP ${res.status}`;
  let activeRevisionId: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; errors?: unknown; activeRevisionId?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) message = body.error;
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      message = `${message}: ${body.errors.filter((e) => typeof e === 'string').join('; ')}`;
    }
    if (typeof body.activeRevisionId === 'string') activeRevisionId = body.activeRevisionId;
  } catch { /* not JSON */ }
  return { message, ...(activeRevisionId ? { activeRevisionId } : {}) };
}

export async function deckCall<T>(url: string, init: RequestInit = {}, doFetch: Fetch = fetch): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await doFetch(url, {
    credentials: 'include',
    ...init,
    ...(hasBody ? { headers: { 'Content-Type': 'application/json' } } : {}),
  });
  if (!res.ok) {
    const { message, activeRevisionId } = await errorBody(res);
    if (res.status === 409 && activeRevisionId) throw new DeckRevisionConflictError(message, activeRevisionId);
    throw new DeckApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** POST; a body of `undefined` sends none. */
export const deckPost = <T>(url: string, body: unknown, signal?: AbortSignal, doFetch?: Fetch): Promise<T> =>
  deckCall<T>(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) }, doFetch);

export type DeckTenantId = 'assessment' | 'pipelines' | 'orgiq' | 'social';

/**
 * THE deck write rule, as the portal reads it (the server's is `deckWriteAuthority`,
 * middleware/src/lib/deck-shared/authority.ts — keep the two tables in step): a deck
 * is writable (build, save, revise, share) by whoever may run the tenant's agent.
 * Social's is the conversation's PostMessage plus current membership, which only the
 * server can see, so its pages also read the deck's `canEdit`.
 */
export const DECK_WRITE_ACTION: Readonly<Record<DeckTenantId, string>> = {
  assessment: 'RunAssessmentAgent',
  pipelines: 'RunPipeline',
  orgiq: 'DispatchAgentRun',
  social: 'PostMessage',
};

/** Whether `can` (useCapabilities) holds the tenant's deck write action. */
export const canWriteDecks = (tenant: DeckTenantId, can: (action: never) => boolean): boolean =>
  (can as (action: string) => boolean)(DECK_WRITE_ACTION[tenant]);

export interface DeckApiConfig {
  /** Which tenant's rule decides `build` / `revise` / save for these decks. */
  tenant: DeckTenantId;
  /** `/api/assessment`, `/api/initiative-decks`, `/api/pipelines`, `/api/chat`. */
  base: string;
  /** Where the deck routes sit under `base`: `/decks`, or '' when `base` is already the decks collection. */
  decksPath: string;
  /** The list route's filter query parameter: `teamId`, `runId`, `projectId`, `channel`. */
  listParam: string;
  /**
   * This tenant's decks answer `POST <deck>/revise` in the request itself (orgiq,
   * Social). Off for assessment and pipelines, whose revise starts a run the page
   * follows. Enabling it adds `paths.revise` and a working `reviseDeck`.
   */
  revise?: boolean;
}

const enc = encodeURIComponent;

/** The routes and calls every tenant has: list, detail, spec, save, preview, file. */
export function makeDeckApi<Detail extends { id: string } = DeckDetailCore>(cfg: DeckApiConfig) {
  const root = `${cfg.base}${cfg.decksPath}`;
  const paths = {
    list: (filter?: string) => `${root}${filter ? `?${cfg.listParam}=${enc(filter)}` : ''}`,
    detail: (deckId: string) => `${root}/${enc(deckId)}`,
    spec: (deckId: string, revisionId: string) => `${root}/${enc(deckId)}/revisions/${enc(revisionId)}/spec`,
    revisions: (deckId: string) => `${root}/${enc(deckId)}/revisions`,
    revise: (deckId: string) => `${root}/${enc(deckId)}/revise`,
    preview: (deckId: string) => `${root}/${enc(deckId)}/preview`,
    file: (deckId: string, revisionId: string) => `${root}/${enc(deckId)}/revisions/${enc(revisionId)}/file`,
  } as const;

  return {
    paths,
    /** The Cedar action the server's deck write rule asks; `can(writeAction)` drives build / save / revise controls. */
    writeAction: DECK_WRITE_ACTION[cfg.tenant],
    getDeck: (deckId: string, signal?: AbortSignal): Promise<Detail> =>
      deckCall(paths.detail(deckId), signal ? { signal } : {}),
    getRevisionSpec: (deckId: string, revisionId: string, signal?: AbortSignal): Promise<DeckSpec> =>
      deckCall(paths.spec(deckId, revisionId), signal ? { signal } : {}),
    /** Person edit. Rejects with `DeckRevisionConflictError` when `baseRevisionId` is stale. */
    saveRevision: (
      deckId: string, spec: DeckSpec, baseRevisionId: string | null, opts: { lockedSlideIds?: string[]; label?: string } = {},
    ): Promise<DeckRevisionInfo> => deckPost(paths.revisions(deckId), { spec, baseRevisionId, ...opts }),
    previewDeck: (deckId: string, spec: DeckSpec, signal?: AbortSignal): Promise<DeckPreviewResult> =>
      deckPost(paths.preview(deckId), { spec }, signal),
    /**
     * Instruct the agent on one slide (or the deck): one new active revision on
     * `baseRevisionId`. Rejects with `DeckRevisionConflictError` when the base is
     * stale. `requestId` makes a retry of the same request a replay, not a second edit.
     */
    reviseDeck: (
      deckId: string, input: { instruction: string; slideId?: string; baseRevisionId: string; requestId?: string },
    ): Promise<DeckReviseResult> => cfg.revise
      ? deckPost(paths.revise(deckId), input)
      : Promise.reject(new DeckApiError(404, 'The agent cannot revise these decks.')),
  };
}

/** How a narrative outcome reads; each key overrides the default sentence of that status. */
export interface NarrativeWording {
  /** A run that always asks for prose has no `requested` flag to check. Default true: nothing is said unless it was asked for. */
  requireRequested: boolean;
  applied: string;
  partial: (templated: number) => string;
  fallback: string;
  unavailable: (reason: string | undefined) => string;
}

/** One sentence for what the narrative request produced (null when none was asked); `record` names what the quotes are checked against. */
export function makeNarrativeNotice(record: string, wording: Partial<NarrativeWording> = {}): (n: NarrativeOutcome | Omit<NarrativeOutcome, 'requested'> | undefined) => string | null {
  const w: NarrativeWording = {
    requireRequested: true,
    applied: `Nova wrote the narrative; every claim is quoted from the ${record}.`,
    partial: (t) => `Nova narrative used on some slides; ${t} kept template text because its quotes did not check out.`,
    fallback: `Nova narrative did not check out against the ${record}, so template text was used.`,
    unavailable: (reason) => `The narrative agent was not available${reason ? ` (${reason})` : ''}; template text was used.`,
    ...wording,
  };
  return (n) => {
    if (!n || (w.requireRequested && !(n as NarrativeOutcome).requested)) return null;
    switch (n.status) {
      case 'applied': return w.applied;
      case 'partial': return w.partial(n.templatedSlideIds.length);
      case 'fallback': return w.fallback;
      case 'unavailable': return w.unavailable(n.reason);
      default: return null;
    }
  };
}

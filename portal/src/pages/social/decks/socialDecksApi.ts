// Typed client for Social `/deck` (docs/agentic-flows-migration.md slice 5):
// the command's run routes and the saved deck's routes, all under /api/chat
// (middleware routes/social-deck.ts). Pages and hooks never build these URLs
// themselves. Types and the error classes are the assessment deck client's
// (same wire shapes). Pure and fetch-injectable so `node --test` loads it
// without a DOM.

import type { AgentRunStatus, ChatCommand } from '@connorhoehnslalom/ui-components/social';
import { parseDeckText } from '@connorhoehnslalom/ui-components/doc-editor';
import {
  deckCall, deckPost, makeDeckApi, makeNarrativeNotice,
  type DeckDetailCore, type DeckSpec, type Fetch, type NarrativeOutcome as DeckNarrative,
} from '../../../components/decks/deckApi.ts';

export type { DeckSpec };

const BASE = '/api/chat';
const api = makeDeckApi<SocialDeckDetail>({ tenant: 'social', base: BASE, decksPath: '/decks', listParam: 'channel', revise: true });
export const DECK_PIPELINE_ID = 'conversation-deck';

export interface SocialDeckDetail extends DeckDetailCore {
  /** The conversation the deck was built from. */
  channel: string;
  /** A short label for it ("#general"). */
  source: string;
  ownerId: string;
  /** Only the person who built the deck edits it; members of the conversation read, download and post. */
  canEdit: boolean;
}

/** The run's narrative result: the shared outcome without `requested` (a /deck run always asks). */
export type NarrativeOutcome = Omit<DeckNarrative, 'requested'>;

export interface DeckRunResult {
  title: string;
  deckId: string | null;
  preview: boolean;
  spec: DeckSpec;
  slides: Array<{ id: string; svg: string; title?: string; generated?: boolean }>;
  warnings: string[];
  narrative: NarrativeOutcome;
  messageCount: number;
  pages: Array<{ kind: string; id: string; title: string }>;
  sourceMessageIds: string[];
}
export type DeckPhase = 'received' | 'running' | 'completed' | 'failed';
export interface DeckRunStatus {
  runId: string; channel: string; phase: DeckPhase;
  steps: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed' }>;
  error: string | null;
  /** True for `--preview`: nothing is stored until Save deck. */
  preview: boolean;
  /** The stored deck, once there is one (auto-saved, or after Save deck). */
  deckId: string | null;
  result: DeckRunResult | null;
  updatedAt?: string;
}
export interface SavedDeck { deckId: string; revisionId: string; created: boolean }
export interface DeckPostMessage {
  channel: string; deckId: string; revisionId: string; fileName: string; fileUrl: string;
  text: string; metadata: Record<string, unknown>;
}

export const socialDeckPaths = {
  run: `${BASE}/commands/deck/run`,
  status: (runId: string) => `${BASE}/commands/deck/runs/${encodeURIComponent(runId)}`,
  saveRun: (runId: string) => `${BASE}/commands/deck/runs/${encodeURIComponent(runId)}/save`,
  ...api.paths,
  post: (deckId: string) => `${BASE}/decks/${encodeURIComponent(deckId)}/post`,
  page: (deckId: string) => `/social/decks/${encodeURIComponent(deckId)}`,
} as const;

export const startDeck = (channel: string, argumentText: string, doFetch?: Fetch):
  Promise<{ runId: string; pipelineId: string; card: Record<string, unknown> }> => deckPost(socialDeckPaths.run, { channel, text: argumentText }, undefined, doFetch);
export const fetchDeckStatus = (runId: string, signal?: AbortSignal, doFetch?: Fetch): Promise<DeckRunStatus> =>
  deckCall(socialDeckPaths.status(runId), signal ? { signal } : {}, doFetch);
export const saveDeckRun = (runId: string, doFetch?: Fetch): Promise<SavedDeck> => deckPost(socialDeckPaths.saveRun(runId), undefined, undefined, doFetch);
export const requestDeckPost = (deckId: string, doFetch?: Fetch): Promise<DeckPostMessage> => deckPost(socialDeckPaths.post(deckId), undefined, undefined, doFetch);

export const getSocialDeck = api.getDeck;
export const getSocialDeckSpec = api.getRevisionSpec;
export const previewSocialDeck = api.previewDeck;
/** Person edit. Rejects with `DeckRevisionConflictError` when `baseRevisionId` is stale. */
export const saveSocialDeckRevision = api.saveRevision;
/** Agent revise (the deck's owner): answered in the request; see `DeckReviseResult`. */
export const reviseSocialDeck = api.reviseDeck;

export const isTerminal = (s: Pick<DeckRunStatus, 'phase'>): boolean => s.phase === 'completed' || s.phase === 'failed';
/** The offline fallback (useFlowRun follows `social:flowrun:sdk-…` live): poll quickly, then back off; bounded. */
export const MAX_POLLS = 120;
export const pollDelayMs = (attempt: number): number => Math.min(2500, 400 + attempt * 300);

/** `--preview` anywhere in the text (the server re-reads it; this only decides what the card offers). */
export const wantsPreview = (argumentText: string): boolean => parseDeckText(argumentText).preview;

/** What `AgentRunCard` reads. */
export function deckRunStatusOf(s: DeckRunStatus): AgentRunStatus {
  const running = s.steps.find((step) => step.status === 'running');
  return {
    phase: s.phase,
    details: { steps: s.steps.map(({ id, label, status }) => ({ id, label, status })), ...(s.error ? { error: s.error } : {}) },
    ...(running ? { stepLabel: running.label } : {}),
    ...(s.phase === 'failed' ? { detail: s.error ?? 'The deck could not be built.' } : {}),
  };
}

/** One sentence for how Nova's prose was used (null when there was none to write). */
export const narrativeNotice = makeNarrativeNotice('thread', {
  requireRequested: false,
  applied: 'Nova wrote the slide text; every quote is a message from the thread.',
  partial: (t) => `Nova's text was used on some slides; ${t} kept plain quotes because Nova's quotes did not check out against the thread.`,
  fallback: 'Nova\'s quotes did not check out against the thread, so the slides use plain quotes.',
  unavailable: (reason) => `Nova was not available${reason ? ` (${reason})` : ''}; the slides use plain quotes.`,
});

/** Save is offered only for a finished preview that has no stored deck yet. */
export const canSave = (s: DeckRunStatus): boolean => s.phase === 'completed' && s.preview && !s.deckId && !!s.result;
/** Open / Post are offered once a deck is stored. */
export const savedDeckId = (s: DeckRunStatus): string | null => (s.phase === 'completed' ? s.deckId ?? s.result?.deckId ?? null : null);

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Reads the stored deck's .pptx through the BFF's authorized route, as the File the attachment path uploads. */
export async function fetchDeckFile(post: Pick<DeckPostMessage, 'fileUrl' | 'fileName'>, doFetch: Fetch = fetch): Promise<File> {
  const response = await doFetch(post.fileUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(response.status === 404 || response.status === 403 ? 'You can no longer open this deck.' : `The deck file could not be read (${response.status}).`);
  return new File([await response.blob()], post.fileName, { type: PPTX_MIME });
}

/** The attachment message for "Post to conversation": the BFF's text and sourceDeck, plus the uploaded file and the sender's name. */
export function postMetadata(post: DeckPostMessage, attachments: Record<string, unknown>, displayName: string): Record<string, unknown> {
  return { displayName, ...attachments, ...post.metadata };
}

/** `/deck [topic] [#initiative:<id> #work-item:<id>] [--preview]` — a private run card, not a message. */
export const socialDeckCommand: ChatCommand = {
  trigger: '/deck',
  label: 'Build a presentation from this conversation',
  hint: '<what it is about> · #initiative:<id> to cite a page · --from recording:<id> · --preview',
  description: 'Nova builds a deck from what you can read of this conversation, or from a recorded call when you pick one, and every slide cites its messages. Add --preview to see the slides first; nothing is saved until you save it.',
  scope: 'always',
  async run(ctx) {
    const started = await startDeck(ctx.channel, ctx.argumentText);
    return { kind: 'run', runId: started.runId, pipelineId: started.pipelineId, card: started.card,
      echo: ctx.text.trim() || '/deck', visibility: 'private' };
  },
};

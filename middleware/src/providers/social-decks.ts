// Social /deck decks — storage on the shared revision store
// (lib/flow-artifacts) under a social subject, docs/agentic-flows-migration.md
// slice 5. Same shapes as providers/pipeline-decks.ts. Authority is NOT here:
// routes/social-deck.ts decides who may read, edit or post (owner, or a current
// member of the deck's source conversation), then calls these.
//
// A deck's id is derived from the run that built it (`sdk-<uuid>` ->
// `sdeck-<uuid>`), so saving the same run twice — a double click, a retried
// auto-save after a lease expiry — is one deck, not two.
// ⚠️ The Aurora SQL has not run against a live cluster; tests assert its shape.

import { config } from '../config.js';
import { socialDecksFixture, socialDeckRevisionsFixture, type SocialDeckRevisionRow, type SocialDeckRow } from '../mock/social-decks.js';
import { exec } from './aurora.js';
import { createArtifactRevisionStore } from '../lib/flow-artifacts/index.js';
import { validateDeckSpec, type DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import * as shared from '../lib/deck-shared/index.js';
import { createDeckStore } from '../lib/deck-shared/index.js';
import { str, maybe, iso, summaryOf, type DeckPreviewOut, type DeckRevisionSummary, type Result } from '../lib/deck-shared/index.js';
import { clip, type DeckFacts } from '../lib/deck-shared/plan.js';
import { emitSocialWorkGraphEvent, socialConversationOrNull } from '../lib/work-graph/social-events.js';

/** A deck of a conversation changed: the social work graph recomputes (content-free). */
const deckChanged = (channel: string | null | undefined): void => {
  emitSocialWorkGraphEvent({ conversationId: socialConversationOrNull(channel), cause: 'deck' });
};

export type { SocialDeckRow, SocialDeckRevisionRow, DeckRevisionSummary, DeckPreviewOut, Result };

export interface SocialDeckDetail {
  id: string; channel: string; title: string; ownerId: string;
  /** Newest first. */
  revisions: DeckRevisionSummary[];
  activeRevisionId: string | null;
  lockedSlideIds: string[];
  createdAt: string; updatedAt: string;
}
export const socialDeckRevisions = createArtifactRevisionStore<DeckSpec>({
  tenant: 'social', subjectKind: 'conversation', idPrefix: 'sdeck', revisionPrefix: 'srev',
  artifactTable: 'social_decks', revisionTable: 'social_deck_revisions',
  emptySpec: { title: '', slides: [] },
  mock: { artifacts: () => socialDecksFixture.rows(), revisions: () => socialDeckRevisionsFixture.rows() },
});

export const isDeckId = (v: unknown): v is string => socialDeckRevisions.isArtifactId(v);
export const isRevisionId = (v: unknown): v is string => socialDeckRevisions.isRevisionId(v);

/** `sdk-<uuid>` -> `sdeck-<uuid>`; null for anything that is not a Social deck run id. */
export function deckIdForRun(runId: string): string | null {
  const m = /^sdk-([0-9a-f-]{36})$/.exec(runId);
  return m ? `sdeck-${m[1]}` : null;
}


const DECK_COLS = `id, channel, run_id, title, created_by, ${iso('created_at')} AS created_at, ${iso('updated_at')} AS updated_at, head_revision_id`;
const deckFromRow = (r: Record<string, unknown>): SocialDeckRow => ({
  id: String(r['id']), channel: String(r['channel']), runId: r['run_id'] == null ? null : String(r['run_id']),
  title: String(r['title']), createdBy: String(r['created_by']),
  createdAt: String(r['created_at']), updatedAt: String(r['updated_at']),
  headRevisionId: r['head_revision_id'] == null ? null : String(r['head_revision_id']),
});

const baseDeckStore = createDeckStore<SocialDeckRow>({
  table: 'social_decks', cols: DECK_COLS, fixture: socialDecksFixture,
  subject: { col: 'channel', prop: 'channel' }, fromRow: deckFromRow, revisions: socialDeckRevisions,
  insert: {
    columns: ['id', 'channel', 'run_id', 'title', 'created_by'], idempotent: true,
    params: (row) => [str('id', row.id), str('channel', row.channel), maybe('run_id', row.runId), str('title', row.title), str('created_by', row.createdBy)],
  },
});

export const socialDeckStore = {
  ...baseDeckStore,

  /** Decks the person owns, newest first. */
  async listOwned(userId: string, channel?: string): Promise<SocialDeckRow[]> {
    if (config.mock.aurora) {
      return socialDecksFixture.rows().filter((d) => d.createdBy === userId && (!channel || d.channel === channel))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const rows = channel
      ? await exec(`SELECT ${DECK_COLS} FROM social_decks WHERE created_by = :u AND channel = :c ORDER BY updated_at DESC LIMIT 100`, [str('u', userId), str('c', channel)])
      : await exec(`SELECT ${DECK_COLS} FROM social_decks WHERE created_by = :u ORDER BY updated_at DESC LIMIT 100`, [str('u', userId)]);
    return rows.map(deckFromRow);
  },
};

export async function getDeckDetail(id: string): Promise<SocialDeckDetail | null> {
  const deck = await socialDeckStore.getDeck(id);
  if (!deck) return null;
  const revisions = await socialDeckStore.listRevisions(id);
  const active = revisions.find((r) => r.id === deck.headRevisionId);
  return {
    id: deck.id, channel: deck.channel, title: deck.title, ownerId: deck.createdBy, revisions: revisions.map(summaryOf),
    activeRevisionId: deck.headRevisionId, lockedSlideIds: active?.lockedSlideIds ?? [],
    createdAt: deck.createdAt, updatedAt: deck.updatedAt,
  };
}

export const getRevisionSpec = (deckId: string, revisionId: string): Promise<DeckSpec | null> =>
  shared.getRevisionSpec(socialDeckRevisions, null, deckId, revisionId);

/**
 * Writes the deck a finished run built (revision 1). Idempotent per run: a
 * second call returns the same deck. The CALLER has decided this person may.
 */
export async function saveGeneratedDeck(input: {
  runId: string; channel: string; spec: DeckSpec; summary: string; sub: string;
}): Promise<Result<{ deckId: string; revisionId: string; created: boolean }>> {
  const deckId = deckIdForRun(input.runId);
  if (!deckId) return { ok: false, status: 400, reason: 'not a deck run' };
  const valid = validateDeckSpec(input.spec);
  if (!valid.ok) return { ok: false, status: 400, reason: 'the generated deck is not valid', details: { errors: valid.errors } };
  const before = await socialDeckStore.getDeck(deckId);
  if (before) {
    if (before.createdBy !== input.sub) return { ok: false, status: 404, reason: 'deck not found' };
    if (before.headRevisionId) return { ok: true, value: { deckId, revisionId: before.headRevisionId, created: false } };
  }
  await socialDeckStore.insertDeck({ id: deckId, channel: input.channel, runId: input.runId, title: valid.spec.title, createdBy: input.sub, headRevisionId: null });
  const appended = await socialDeckStore.appendRevision({
    id: socialDeckRevisions.newRevisionId(), deckId, baseRevisionId: null, label: 'Generated from conversation',
    spec: valid.spec, lockedSlideIds: [], producedBy: 'generated', createdBy: input.sub, summary: clip(input.summary, 800),
  });
  if (appended.ok) { deckChanged(input.channel); return { ok: true, value: { deckId, revisionId: appended.revision.id, created: true } }; }
  // Lost the race to another save of the same run: that one is the deck.
  return appended.head
    ? { ok: true, value: { deckId, revisionId: appended.head, created: false } }
    : { ok: false, status: 409, reason: 'the deck changed while it was saved' };
}

export const savePersonRevision = async (
  deckId: string, body: { spec?: unknown; baseRevisionId?: unknown; lockedSlideIds?: unknown; label?: unknown }, sub: string,
): Promise<Result<DeckRevisionSummary>> => {
  const result = await shared.savePersonRevision(socialDeckRevisions, () => socialDeckStore.getDeck(deckId), deckId, body, sub);
  if (result.ok) deckChanged((await socialDeckStore.getDeck(deckId).catch(() => null))?.channel);
  return result;
};

/** Renders any DeckSpec the caller sends (nothing is stored). */
export const previewSpec = shared.previewSpec;

export const renderRevisionFile = (deckId: string, revisionId: string): Promise<{ bytes: Buffer; filename: string } | null> =>
  shared.renderRevisionFile(socialDeckRevisions, () => socialDeckStore.getDeck(deckId), deckId, revisionId, 'conversation-deck');

// ─── Agent revise (synchronous) ──────────────────────────────────────────────
//
// `POST /decks/:id/revise` (owner + PostMessage, like a save). The caller (the
// route) rebuilds the facts from the conversation the OWNER can read right now
// — membership, history floor and deleted messages applied — and passes them in
// as `loadFacts`; a deck whose conversation can no longer be read is refused.
import { refreshPageSlides } from '../lib/social-deck/facts.js';
export const reviseDeck = async (
  deckId: string, body: { instruction?: unknown; slideId?: unknown; baseRevisionId?: unknown; requestId?: unknown },
  sub: string, loadFacts: (deck: SocialDeckRow, base: DeckSpec) => Promise<DeckFacts | null>,
): Promise<Result<shared.DeckReviseOut>> => {
  const result = await reviseDeckRaw(deckId, body, sub, loadFacts);
  if (result.ok) deckChanged((await socialDeckStore.getDeck(deckId).catch(() => null))?.channel);
  return result;
};
const reviseDeckRaw = (
  deckId: string, body: { instruction?: unknown; slideId?: unknown; baseRevisionId?: unknown; requestId?: unknown },
  sub: string, loadFacts: (deck: SocialDeckRow, base: DeckSpec) => Promise<DeckFacts | null>,
): Promise<Result<shared.DeckReviseOut>> =>
  shared.reviseDeckSync<SocialDeckRow>({
    tenant: 'social', revisions: socialDeckRevisions, lookup: () => socialDeckStore.getDeck(deckId), deckId, revisionPrefix: 'srev',
    facts: loadFacts, refresh: refreshPageSlides, agentId: 'orgiq-assessment-drafter', sub, body,
  });

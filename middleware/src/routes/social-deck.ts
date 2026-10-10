// Social `/deck` — mounted at /api/chat (beside chatPinsRouter and the
// /summarize router). docs/agentic-flows-migration.md slice 5. References:
// realtime-examples deckCommand.ts (the command) and platform-api
// src/routes/chatCommands.ts:76-79 (member check before the run).
//
//   POST /commands/deck/run               {channel, text}  202 {runId, pipelineId, card}
//   GET  /commands/deck/runs/:id          the requester's own run
//   POST /commands/deck/runs/:id/save     PostMessage; the ONLY write for a --preview run
//   GET  /decks?channel=                  the caller's own decks
//   GET  /decks/:id                       owner, or a CURRENT member of the source conversation
//   GET  /decks/:id/revisions/:rid/spec   same read authority
//   POST /decks/:id/revisions             deckWriteAuthority (PostMessage + current member); CAS 409
//   POST /decks/:id/revise                deckWriteAuthority (PostMessage + current member); 201 { revisionId, summary, changedSlideIds, engine, replayed },
//                                         200 on a requestId replay or no change; 409 stale base / locked slide
//   POST /decks/:id/preview               read authority; renders the posted spec, stores nothing
//   GET  /decks/:id/revisions/:rid/file   read authority; the .pptx
//   POST /decks/:id/post                  deckWriteAuthority (share); returns the
//                                         server-built message — sending it is the caller's act
//
// Reading the conversation is ViewSocial (a POST that only reads, like
// /summarize) and goes through the same readChatLines (membership, history
// floor, deleted messages). A deck's authority is checked FRESH on every
// request: a member who left, or whose grant was revoked, is a 404 at once.
// A person who is not the owner and not a member gets 404, never 403.

import { Router, type Request } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { deckWriteAuthority, makeDeckHandlers, sendFail as fail } from '../lib/deck-shared/index.js';
import { canonicalCallPage } from '../lib/call-pages.js';
import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import type { DeckFacts } from '../lib/deck-shared/plan.js';
import { buildConversationDeckFacts, citedPagesOf } from '../lib/social-deck/facts.js';
import { parseDeckArgs, deckTitleFrom } from '../lib/social-deck/args.js';
import type { DeckPageFact } from '../lib/social-deck/facts.js';
import {
  DECK_PIPELINE_ID, MAX_ACTIVE_DECK_RUNS_PER_USER, activeDeckRunCount, conversationLabel, deckView, findDeckRun, getDeckRunFor, startDeckRun,
} from '../lib/social-deck.js';
import { pendingFlowRuns, flowRunStore, type FlowRunRow } from '../lib/flow-runs/index.js';
import * as decks from '../providers/social-decks.js';
import { getUser } from '../providers/identity.js';
import { readRecordingLines } from '../lib/recording-source.js';
import { chatAccess, socialSubject } from './chat-pins.js';
import { readChatLines } from './chat-pins.js';

export const socialDeckRouter = Router();

/** Settles when every started deck run has finished (tests await it; routes never do). */
export const pendingDecks = pendingFlowRuns;

const RUN_ID = /^sdk-[0-9a-f-]{36}$/;
function runId(raw: unknown): string {
  if (typeof raw !== 'string' || !RUN_ID.test(raw)) throw new NotFoundError('run not found');
  return raw;
}

// ─── The command ─────────────────────────────────────────────────────────────

/** Pages the caller may cite: OrgIQ access now, then the canonical (existing) page. */
async function resolvePages(
  userId: string, requested: ReadonlyArray<{ kind: 'initiative' | 'work-item'; id: string }>, lenient = false,
): Promise<DeckPageFact[]> {
  if (requested.length === 0) return [];
  let user;
  try { user = await getUser(userId, { authoritative: true }); }
  catch { throw new AppError(503, 'The identity store is unavailable'); }
  if ((user?.grants.orgiq?.length ?? 0) === 0) {
    if (lenient) return requested.map(p => ({ ...p, title: '', trail: '', unavailable: true }));
    throw new AppError(403, 'Work access is required to cite a page');
  }
  const out: DeckPageFact[] = [];
  for (const page of requested) {
    try {
      const canonical = await canonicalCallPage(page);
      out.push({ kind: page.kind, id: page.id, title: canonical.title, trail: canonical.breadcrumbs.map(b => b.title).join(' / ') });
    } catch (error) {
      if (lenient && error instanceof AppError && [403, 404].includes(error.status)) { out.push({ ...page, title: '', trail: '', unavailable: true }); continue; }
      if (error instanceof AppError && [403, 404].includes(error.status)) throw new ValidationError(`The page ${page.kind}:${page.id} is not available to you`);
      throw error;
    }
  }
  return out;
}

/** The run's start, shared by the route and the `/agent` loop's step (same gate, fresh each call). */
export async function beginSocialDeck(req: Request, channel: string, text: string): Promise<FlowRunRow> {
  const userId = await chatAccess(req, channel, 'ViewSocial');
  const parsed = parseDeckArgs(text);
  if (!parsed.ok) throw new ValidationError(parsed.error);
  const { topic, preview, pages: requestedPages, recordingId } = parsed.value;
  if (await activeDeckRunCount(userId) >= MAX_ACTIVE_DECK_RUNS_PER_USER) throw new AppError(429, 'Wait for your running decks to finish');
  const pages = await resolvePages(userId, requestedPages);
  // A recording is the source INSTEAD of the thread (slice 7): its transcript, read under the
  // caller's own participation in a call of this conversation (lib/recording-source.ts).
  const lines = recordingId ? await readRecordingLines(req, userId, channel, recordingId) : await readChatLines(channel, userId, null);
  if (lines.length === 0 && pages.length === 0) throw new AppError(422, 'There are no messages you can read in this conversation to build a deck from.');
  const label = conversationLabel(channel);
  const title = deckTitleFrom(topic, `${label} deck`);
  return startDeckRun({ userId, channel, lines, pages, title, conversationName: label, preview, ...(recordingId ? { recordingId } : {}) });
}

socialDeckRouter.post('/commands/deck/run', asyncHandler(async (req, res) => {
  const channel = typeof req.body?.channel === 'string' ? req.body.channel.trim() : '';
  if (!channel || channel.length > 240) throw new ValidationError('channel is required');
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (text.length > 600) throw new ValidationError('the command text is too long');
  const run = await beginSocialDeck(req, channel, text);
  const preview = (run.input as { preview?: unknown } | null)?.preview === true;
  res.status(202).json({
    runId: run.id, pipelineId: DECK_PIPELINE_ID,
    card: { kind: 'agent-run', command: '/deck', instruction: `/deck ${text.trim()}`.trim(), agentName: 'Nova', cardKind: preview ? 'deck-preview' : 'deck' },
  });
}));

/** The run, if it is the caller's. Membership is re-checked for the run's channel, then ownership. */
async function ownRun(req: Request, id: string, action: 'ViewSocial' | 'PostMessage'): Promise<FlowRunRow> {
  const any = await findDeckRun(id);
  if (!any) throw new NotFoundError('run not found');
  const userId = await chatAccess(req, any.scope, action);
  const run = await getDeckRunFor(userId, id);
  if (!run) throw new NotFoundError('run not found');
  return run;
}

socialDeckRouter.get('/commands/deck/runs/:id', asyncHandler(async (req, res) => {
  const run = await ownRun(req, runId(req.params['id']), 'ViewSocial');
  const v = deckView(run);
  res.json({ runId: v.id, channel: v.channel, phase: v.phase, steps: v.steps, error: v.error, preview: v.preview, deckId: v.savedDeckId, result: v.result, updatedAt: v.updatedAt });
}));

socialDeckRouter.post('/commands/deck/runs/:id/save', asyncHandler(async (req, res) => {
  const run = await ownRun(req, runId(req.params['id']), 'PostMessage');
  const v = deckView(run);
  if (v.phase !== 'completed' || !v.result) throw new AppError(409, 'The deck is not finished');
  const saved = await decks.saveGeneratedDeck({
    runId: run.id, channel: run.scope, spec: v.result.spec, summary: `Built from ${v.result.messageCount} ${(run.input as { recordingId?: unknown } | null)?.recordingId ? 'transcript segments' : 'messages'}.`, sub: run.requestedBy,
  });
  if (!saved.ok) { fail(res, saved); return; }
  await flowRunStore.setMetaOnce(run.id, run.requestedBy, 'deckId', saved.value.deckId).catch(() => false);
  res.status(saved.value.created ? 201 : 200).json(saved.value);
}));

// ─── Decks ───────────────────────────────────────────────────────────────────

interface DeckAccess { deck: decks.SocialDeckRow; userId: string; owner: boolean; canWrite: boolean }

/** The deck write rule's answer for this request (lib/deck-shared/authority.ts), as a flag for `canEdit`. */
async function canWriteDeck(req: Request, deck: decks.SocialDeckRow): Promise<boolean> {
  try { await deckWriteAuthority('social', { tenant: 'social', channel: deck.channel, ownerId: deck.createdBy }, req, 'save'); return true; }
  catch (error) { if (error instanceof AppError && [401, 403].includes(error.status)) return false; throw error; }
}

/** Owner (with ViewSocial), or a CURRENT member of the source conversation; otherwise a 404. */
async function readableDeck(req: Request, raw: unknown): Promise<DeckAccess> {
  const id = h.deckId(raw);
  const userId = await socialSubject(req, 'ViewSocial');
  const deck = await decks.socialDeckStore.getDeck(id);
  if (!deck) throw new NotFoundError('deck not found');
  if (deck.createdBy === userId) return { deck, userId, owner: true, canWrite: await canWriteDeck(req, deck) };
  try { await chatAccess(req, deck.channel, 'ViewSocial'); }
  catch (error) {
    if (error instanceof AppError && [401, 403].includes(error.status)) throw new NotFoundError('deck not found');
    throw error;
  }
  return { deck, userId, owner: false, canWrite: await canWriteDeck(req, deck) };
}

const detailOut = (detail: decks.SocialDeckDetail, access: DeckAccess) =>
  ({ ...detail, canEdit: access.canWrite, source: conversationLabel(detail.channel) });

/**
 * The facts a revise re-applies: the conversation as its owner can read it NOW
 * (membership, history floor, deleted messages), never a stored copy. A deck
 * whose conversation can no longer be read has no facts and is refused.
 */
async function reviseFacts(deck: decks.SocialDeckRow, base: DeckSpec, userId: string): Promise<DeckFacts | null> {
  const lines = await readChatLines(deck.channel, userId, null);
  // The pages the build cited, resolved again as THIS requester: one they can no longer read is marked, not reused.
  const pages = await resolvePages(userId, citedPagesOf(base), true);
  if (lines.length === 0 && !pages.some(p => !p.unavailable)) return null;
  return buildConversationDeckFacts({
    runId: deck.runId ?? deck.id, title: base.title, conversationName: conversationLabel(deck.channel), lines, pages,
  });
}

const h = makeDeckHandlers<DeckAccess>({
  isDeckId: decks.isDeckId, isRevisionId: decks.isRevisionId,
  resolve: (req, id) => readableDeck(req, id),
  detail: async (_id, access) => {
    const detail = await decks.getDeckDetail(access.deck.id);
    return detail ? detailOut(detail, access) : null;
  },
  spec: (_id, rid, access) => decks.getRevisionSpec(access.deck.id, rid),
  saveGuard: async (req, access) => { await deckWriteAuthority('social', { tenant: 'social', channel: access.deck.channel, ownerId: access.deck.createdBy }, req, 'save'); },
  save: (_id, body, access) => decks.savePersonRevision(access.deck.id, body, access.userId),
  revise: (_id, body, access, req) => decks.reviseDeck(access.deck.id, body, access.userId, async (deck, base) => {
    await chatAccess(req, deck.channel, 'ViewSocial'); // a CURRENT member, as when the deck was built
    return reviseFacts(deck, base, access.userId);
  }),
  preview: (_id, spec) => Promise.resolve(decks.previewSpec(spec)),
  file: (_id, rid, access) => decks.renderRevisionFile(access.deck.id, rid),
});

socialDeckRouter.get('/decks', asyncHandler(async (req, res) => {
  const userId = await socialSubject(req, 'ViewSocial');
  const channel = typeof req.query['channel'] === 'string' && req.query['channel'] ? req.query['channel'] : undefined;
  const rows = await decks.socialDeckStore.listOwned(userId, channel);
  res.json(rows.map(d => ({ id: d.id, channel: d.channel, title: d.title, headRevisionId: d.headRevisionId, updatedAt: d.updatedAt })));
}));

socialDeckRouter.get('/decks/:id', h.detail);
socialDeckRouter.get('/decks/:id/revisions/:rid/spec', h.spec);
socialDeckRouter.post('/decks/:id/revisions', h.save);
socialDeckRouter.post('/decks/:id/revise', h.revise);
socialDeckRouter.post('/decks/:id/preview', h.preview);
socialDeckRouter.get('/decks/:id/revisions/:rid/file', h.file);

/**
 * "Post to conversation". Re-asks membership + PostMessage for the deck's
 * conversation now, then hands back the message to send (text built here from
 * the stored deck, never from the request). The caller uploads the .pptx
 * through the existing attachment path and sends it over the gateway; nothing
 * is posted by this call.
 */
socialDeckRouter.post('/decks/:id/post', asyncHandler(async (req, res) => {
  const access = await readableDeck(req, req.params['id']);
  await deckWriteAuthority('social', { tenant: 'social', channel: access.deck.channel, ownerId: access.deck.createdBy }, req, 'share');
  const revision = access.deck.headRevisionId;
  if (!revision) throw new AppError(409, 'The deck has no saved version');
  const detail = await decks.getDeckDetail(access.deck.id);
  const label = detail?.revisions.find(r => r.id === revision)?.label ?? 'v1';
  const file = await decks.renderRevisionFile(access.deck.id, revision);
  if (!file) throw new NotFoundError('revision not found');
  res.json({
    channel: access.deck.channel, deckId: access.deck.id, revisionId: revision, fileName: file.filename,
    fileUrl: `/api/chat/decks/${encodeURIComponent(access.deck.id)}/revisions/${encodeURIComponent(revision)}/file`,
    text: `Shared deck: ${access.deck.title} (${label})`,
    metadata: { sourceDeck: { id: access.deck.id, revisionId: revision } },
  });
}));

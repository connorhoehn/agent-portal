// Orgiq initiative status decks — mounted at /api/initiative-decks behind
// requireTenant('orgiq') (docs/agentic-flows-migration.md slice 6). Reads need a
// session; every write is decided by deckWriteAuthority alone (DispatchAgentRun +
// initiative read), no new Cedar action:
//
//   POST /projects/:projectId        deckWriteAuthority 201 { deckId, revisionId, includesBudget, narrative }
//   GET  /?projectId=                signed-in orgiq   DeckListItem[]   (budget decks only for budget readers)
//   GET  /:id                        signed-in orgiq   DeckDetail
//   GET  /:id/revisions/:rid/spec    signed-in orgiq   DeckSpec
//   POST /:id/revisions              deckWriteAuthority 201 revision summary; 409 stale base
//   POST /:id/preview                signed-in orgiq   { slides, warnings }
//   GET  /:id/revisions/:rid/file    signed-in orgiq   .pptx attachment
//
// Reading a deck is tenant-open like the initiative page itself, EXCEPT a deck
// built with budget figures: that one is "not found" to anyone below the
// budgets read tier (same tier as routes/budgets.ts `readGate`). Its presence
// channel `orgiq:deck:<id>` applies the identical rule (lib/live-principal.ts).

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../lib/async-handler.js';
import { requireSession, resolveSession } from '../lib/authz.js';
import { deckWriteAuthority, makeDeckHandlers, sendFail } from '../lib/deck-shared/index.js';
import * as decks from '../providers/initiative-decks.js';

export const initiativeDecksRouter: Router = Router();

const readGate = requireSession('ViewInitiativeDeck');

/** Roles that read the budgets surface outright — the shared rule lives in the provider. */
export const BUDGET_READ_ROLES: readonly string[] = decks.BUDGET_READ_ROLES;

/** The budgets read tier of this request's session. The orgiq:deck presence
 * channel (lib/live-principal.ts) asks the SAME `deckViewerFor` + `visibleDeck`. */
export const viewerOf = (req: Request): Promise<decks.DeckViewer> => decks.deckViewerFor(resolveSession(req));

/** Every write asks the ONE deck rule (lib/deck-shared/authority.ts), fresh, for the deck's own initiative. */
async function writeDeck(req: Request, deckId: string, op: 'save' | 'revise'): Promise<void> {
  // Ask the rule first, even for an unknown deck: a non-writer is 403 either way, so the
  // answer never separates a missing deck from a budget deck hidden below the read tier.
  const raw = await decks.initiativeDeckStore.getDeck(deckId);
  await deckWriteAuthority('orgiq', { tenant: 'orgiq', projectId: raw?.projectId ?? '' }, req, op);
  if (!await decks.visibleDeck(deckId, await viewerOf(req))) throw new NotFoundError('deck not found');
}

const h = makeDeckHandlers<decks.DeckViewer>({
  saveGuard: (req, _ctx, id) => writeDeck(req, id, 'save'),
  isDeckId: decks.isDeckId, isRevisionId: decks.isRevisionId,
  resolve: (req) => viewerOf(req),
  detail: (id, viewer) => decks.getDeck(id, viewer),
  spec: (id, rid, viewer) => decks.getRevisionSpec(id, rid, viewer),
  save: (id, body, viewer, req) => decks.savePersonRevision(id, body, viewer, req.session?.sub ?? null),
  revise: (id, body, viewer, req) => decks.reviseDeck(id, body, viewer, req.session?.sub ?? null),
  preview: (id, spec, viewer) => decks.previewDeck(id, spec, viewer),
  file: (id, rid, viewer) => decks.renderRevisionFile(id, rid, viewer),
});

initiativeDecksRouter.post('/projects/:projectId', asyncHandler(async (req, res) => {
  await deckWriteAuthority('orgiq', { tenant: 'orgiq', projectId: String(req.params['projectId'] ?? '') }, req, 'build');
  const result = await decks.createDeck(String(req.params['projectId'] ?? ''), (req.body ?? {}) as Record<string, unknown>, await viewerOf(req), req.session?.sub ?? null);
  if (!result.ok) { sendFail(res, result); return; }
  res.status(201).json(result.value);
}));

initiativeDecksRouter.get('/', readGate, asyncHandler(async (req, res) => {
  const projectId = typeof req.query['projectId'] === 'string' && req.query['projectId'] ? req.query['projectId'] : undefined;
  res.json(await decks.listDecks(await viewerOf(req), projectId));
}));

initiativeDecksRouter.get('/:id', readGate, h.detail);
initiativeDecksRouter.get('/:id/revisions/:rid/spec', readGate, h.spec);
initiativeDecksRouter.post('/:id/revisions', h.save);
initiativeDecksRouter.post('/:id/revise', h.revise);
initiativeDecksRouter.post('/:id/preview', readGate, h.preview);
initiativeDecksRouter.get('/:id/revisions/:rid/file', readGate, h.file);

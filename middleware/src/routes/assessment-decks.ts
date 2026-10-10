// Assessment review decks — mounted inside assessmentRouter (so behind its
// requireTenant('assessment') gate) at /api/assessment. The API table and its
// gates are docs/assessment-deck-goal.md's:
//
//   POST /teams/:teamId/decks                 deckWriteAuthority  202 { deckId, runId }
//   GET  /decks?teamId=                       ViewAssessment      DeckListItem[]
//   GET  /decks/:id                           ViewAssessment      DeckDetail
//   GET  /decks/:id/revisions/:rid/spec       ViewAssessment      DeckSpec
//   POST /decks/:id/revisions                 deckWriteAuthority    201 revision summary; 409 stale base
//   POST /decks/:id/preview                   ViewAssessment      { slides, warnings }
//   POST /decks/:id/revise                    deckWriteAuthority  202 { runId }; 409 stale base
//   GET  /decks/:id/revisions/:rid/file       ViewAssessment      .pptx attachment
//
// Writes (build / save / revise) are decided by deckWriteAuthority alone
// (RunAssessmentAgent + current team read); reads keep ViewAssessment.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { deckWriteAuthority, makeDeckHandlers, sendFail } from '../lib/deck-shared/index.js';
import * as decks from '../providers/assessment-decks.js';
import { isValidTeamId } from '../providers/assessment.js';

export const assessmentDecksRouter: Router = Router();

const viewGate = requireAction('ViewAssessment');

/** Every write below asks the ONE deck rule (lib/deck-shared/authority.ts), fresh, for the deck's own team. */
async function writeDeck(req: Request, deckId: string, op: 'save' | 'revise'): Promise<void> {
  const deck = await decks.getDeck(deckId);
  if (!deck) throw new NotFoundError('deck not found');
  await deckWriteAuthority('assessment', { tenant: 'assessment', teamId: deck.teamId }, req, op);
}

const h = makeDeckHandlers({
  saveGuard: (req, _ctx, id) => writeDeck(req, id, 'save'),
  isDeckId: decks.isDeckId, isRevisionId: decks.isRevisionId,
  detail: (id) => decks.getDeck(id),
  spec: (id, rid) => decks.getRevisionSpec(id, rid),
  save: (id, body, _ctx, req) => decks.savePersonRevision(id, body, req.session?.sub ?? null),
  preview: (id, spec) => decks.previewDeck(id, spec),
  file: (id, rid) => decks.renderRevisionFile(id, rid),
});

assessmentDecksRouter.post('/teams/:teamId/decks', asyncHandler(async (req, res) => {
  const teamId = String(req.params['teamId'] ?? '');
  if (!isValidTeamId(teamId)) throw new ValidationError('team id must match ^TEAM-[A-Za-z0-9-]+$');
  await deckWriteAuthority('assessment', { tenant: 'assessment', teamId }, req, 'build');
  const result = await decks.createDeck(teamId, (req.body ?? {}) as Record<string, unknown>, req.session?.sub ?? null);
  if (!result.ok) { sendFail(res, result); return; }
  res.status(202).json(result.value);
}));

assessmentDecksRouter.get('/decks', viewGate, asyncHandler(async (req, res) => {
  const teamId = typeof req.query['teamId'] === 'string' && req.query['teamId'] ? req.query['teamId'] : undefined;
  if (teamId !== undefined && !isValidTeamId(teamId)) throw new ValidationError('teamId must match ^TEAM-[A-Za-z0-9-]+$');
  res.json(await decks.listDecks(teamId));
}));

assessmentDecksRouter.get('/decks/:id', viewGate, h.detail);
assessmentDecksRouter.get('/decks/:id/revisions/:rid/spec', viewGate, h.spec);
assessmentDecksRouter.post('/decks/:id/revisions', h.save);
assessmentDecksRouter.post('/decks/:id/preview', viewGate, h.preview);

assessmentDecksRouter.post('/decks/:id/revise', asyncHandler(async (req, res) => {
  const id = h.deckId(req.params['id']);
  await writeDeck(req, id, 'revise');
  const result = await decks.reviseDeck(id, (req.body ?? {}) as Record<string, unknown>, req.session?.sub ?? null);
  if (!result.ok) { sendFail(res, result); return; }
  res.status(202).json(result.value);
}));

assessmentDecksRouter.get('/decks/:id/revisions/:rid/file', viewGate, h.file);

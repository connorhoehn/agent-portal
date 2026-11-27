// Pipeline run report decks — mounted inside pipelinesRouter (behind
// requireTenant('pipelines')) at /api/pipelines (docs/agentic-flows-migration.md
// slice 3). Reads keep ViewPipelines; every write is decided by deckWriteAuthority
// alone (RunPipeline + current run read), no new Cedar action:
//
//   POST /runs/:id/decks                   deckWriteAuthority 201 { deckId, revisionId, narrative }
//   GET  /decks?runId=                     ViewPipelines  DeckListItem[]
//   GET  /decks/:id                        ViewPipelines  DeckDetail
//   GET  /decks/:id/revisions/:rid/spec    ViewPipelines  DeckSpec
//   POST /decks/:id/revisions              deckWriteAuthority 201 revision summary; 409 stale base
//   POST /decks/:id/preview                ViewPipelines  { slides, warnings }
//   POST /decks/:id/revise                 deckWriteAuthority 202 { runId }; 409 { error, activeRevisionId } stale base
//   GET  /decks/:id/runs/:runId            ViewPipelines  the requester's own revise run (DeckRunState)
//   GET  /decks/:id/revisions/:rid/file    ViewPipelines  .pptx attachment

import { Router, type Request } from 'express';
import { AppError, NotFoundError, asyncHandler } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { applyDeckOperations, deckWriteAuthority, makeDeckHandlers, makeTemplateHandlers, sendFail } from '../lib/deck-shared/index.js';
import * as decks from '../providers/pipeline-decks.js';
import { notifyPipelinesWorkGraphChanged } from '../lib/work-graph/live.js';

export const pipelineDecksRouter: Router = Router();

const viewGate = requireAction('ViewPipelines');

/** Every write below asks the ONE deck rule (lib/deck-shared/authority.ts), fresh, for the deck's own run. */
async function writeDeck(req: Request, deckId: string, op: 'save' | 'revise'): Promise<string> {
  const deck = await decks.getDeck(deckId);
  if (!deck) throw new NotFoundError('deck not found');
  return (await deckWriteAuthority('pipelines', { tenant: 'pipelines', runId: deck.runId }, req, op)).sub;
}

const h = makeDeckHandlers({
  saveGuard: async (req, _ctx, id) => { await writeDeck(req, id, 'save'); },
  isDeckId: decks.isDeckId, isRevisionId: decks.isRevisionId,
  detail: (id) => decks.getDeck(id),
  spec: (id, rid) => decks.getRevisionSpec(id, rid),
  save: (id, body, _ctx, req) => decks.savePersonRevision(id, body, req.session?.sub ?? null),
  preview: (id, spec) => decks.previewDeck(id, spec),
  file: (id, rid, _ctx, format) => decks.renderRevisionFile(id, rid, format),
  operations: (id, body, _ctx, req) => applyDeckOperations({
    tenant: 'pipelines', revisions: decks.pipelineDeckRevisions, lookup: () => decks.pipelineDeckStore.getDeck(id), deckId: id, body, sub: req.session?.sub ?? null,
  }),
  chartReports: async (id) => (await decks.pipelineDeckStore.getDeck(id)) ? { reports: [] } : null,
});

pipelineDecksRouter.post('/runs/:id/decks', asyncHandler(async (req, res) => {
  await deckWriteAuthority('pipelines', { tenant: 'pipelines', runId: String(req.params['id'] ?? '') }, req, 'build');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = body['templateId'] !== undefined
    ? await decks.createDeckFromTemplate(String(req.params['id'] ?? ''), body, req.session?.sub ?? null)
    : await decks.createDeck(String(req.params['id'] ?? ''), body, req.session?.sub ?? null);
  if (!result.ok) { sendFail(res, result); return; }
  void notifyPipelinesWorkGraphChanged(String(req.params['id'] ?? ''), 'deck');
  res.status(201).json(result.value);
}));

const t = makeTemplateHandlers('pipelines');
pipelineDecksRouter.get('/deck-templates', viewGate, t.list);
pipelineDecksRouter.get('/deck-templates/:templateId', viewGate, t.read);
pipelineDecksRouter.get('/deck-layouts', viewGate, t.layouts);

pipelineDecksRouter.get('/decks', viewGate, asyncHandler(async (req, res) => {
  const runId = typeof req.query['runId'] === 'string' && req.query['runId'] ? req.query['runId'] : undefined;
  res.json(await decks.listDecks(runId));
}));

pipelineDecksRouter.get('/decks/:id', viewGate, h.detail);
pipelineDecksRouter.get('/decks/:id/revisions/:rid/spec', viewGate, h.spec);
pipelineDecksRouter.post('/decks/:id/revisions', h.save);
pipelineDecksRouter.post('/decks/:id/preview', viewGate, h.preview);
pipelineDecksRouter.post('/decks/:id/operations', h.operations); // writeDeck → deckWriteAuthority
pipelineDecksRouter.get('/decks/:id/chart-reports', viewGate, h.chartReports);
pipelineDecksRouter.get('/decks/:id/revisions/:rid/file', viewGate, h.file);

// Agent revise: a requester-private durable flow run (`pdr-…`, lib/flow-runs).
// The run's push channel is `pipelines:flowrun:<runId>`, admitted to its
// requester alone (live-principal.ts); this GET is the record behind it.
pipelineDecksRouter.post('/decks/:id/revise', asyncHandler(async (req, res) => {
  const id = h.deckId(req.params['id']);
  const sub = await writeDeck(req, id, 'revise');
  const result = await decks.reviseDeck(id, (req.body ?? {}) as Record<string, unknown>, sub);
  if (!result.ok) { sendFail(res, result); return; }
  res.status(202).json(result.value);
}));

pipelineDecksRouter.get('/decks/:id/runs/:runId', viewGate, asyncHandler(async (req, res) => {
  const sub = req.session?.sub;
  if (!sub) throw new AppError(401, 'Sign in to read a run');
  const deckId = h.deckId(req.params['id']);
  const runId = String(req.params['runId'] ?? '');
  if (!/^pdr-[0-9a-f-]{36}$/.test(runId)) throw new NotFoundError('run not found');
  const run = await decks.getReviseRunFor(sub, deckId, runId);
  if (!run) throw new NotFoundError('run not found');
  res.json(decks.reviseRunView(run));
}));

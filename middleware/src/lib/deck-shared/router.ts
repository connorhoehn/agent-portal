// The deck HTTP handlers every tenant copied: id parsing, the error body, the
// detail / spec / save / preview / .pptx download handlers.
//
// This returns HANDLERS, not a mounted router, on purpose: each tenant router
// still declares `router.get('/decks/:id', gate, h.detail)` itself, so the route
// inventory (mock/core/wire/routes.ts reads route literals from source), the
// route-coverage scan and a reader of the tenant file all still see the path
// and the Cedar gate next to each other. What a tenant keeps in its own file:
// its gates, its visibility rule (`resolve`), and its tenant-specific routes.

import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler, NotFoundError } from '../async-handler.js';
import { PPTX_CONTENT_TYPE } from '@connorhoehnslalom/realtime-modules/deck';
import type { DeckSpec } from '@connorhoehnslalom/realtime-modules/deck';
import type { DeckReviseOut } from './revise.js';
import type { DeckPreviewOut, DeckRevisionSummary, Result } from './types.js';

export function sendFail(res: Response, result: { status: number; reason: string; details?: Record<string, unknown> }): void {
  res.status(result.status).json({ error: result.reason, ...(result.details ?? {}) });
}

export function sendPptx(res: Response, file: { bytes: Buffer; filename: string }): void {
  res.setHeader('Content-Type', PPTX_CONTENT_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Content-Length', String(file.bytes.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(file.bytes);
}

export interface DeckHandlerOptions<Ctx> {
  isDeckId: (v: unknown) => boolean;
  isRevisionId: (v: unknown) => boolean;
  /**
   * What this request may do with the deck (a viewer tier, an owner/member
   * check…). Runs after the deck id is validated and before the revision id;
   * throw to refuse. Omit when the tenant's gate alone decides.
   */
  resolve?: (req: Request, deckId: string) => Promise<Ctx>;
  detail: (deckId: string, ctx: Ctx) => Promise<unknown | null>;
  spec: (deckId: string, revisionId: string, ctx: Ctx) => Promise<DeckSpec | null>;
  /** The write check before a save or revise — every tenant passes `deckWriteAuthority` here (lib/deck-shared/authority.ts). */
  saveGuard?: (req: Request, ctx: Ctx, deckId: string) => Promise<void>;
  save: (deckId: string, body: Record<string, unknown>, ctx: Ctx, req: Request) => Promise<Result<DeckRevisionSummary>>;
  /** Agent revise (`POST /:id/revise`); omit for a tenant whose revise is a flow run of its own. Gated by `saveGuard` like a save. */
  revise?: (deckId: string, body: Record<string, unknown>, ctx: Ctx, req: Request) => Promise<Result<DeckReviseOut>>;
  preview: (deckId: string, spec: unknown, ctx: Ctx) => Promise<Result<DeckPreviewOut>>;
  file: (deckId: string, revisionId: string, ctx: Ctx) => Promise<{ bytes: Buffer; filename: string } | null>;
}

export function makeDeckHandlers<Ctx = undefined>(opts: DeckHandlerOptions<Ctx>) {
  const deckId = (raw: unknown): string => {
    if (!opts.isDeckId(raw)) throw new NotFoundError('deck not found');
    return raw as string;
  };
  const revisionId = (raw: unknown): string => {
    if (!opts.isRevisionId(raw)) throw new NotFoundError('revision not found');
    return raw as string;
  };
  const ctxFor = async (req: Request, id: string): Promise<Ctx> =>
    (opts.resolve ? opts.resolve(req, id) : undefined) as Ctx;

  const detail: RequestHandler = asyncHandler(async (req, res) => {
    const id = deckId(req.params['id']);
    const ctx = await ctxFor(req, id);
    const deck = await opts.detail(id, ctx);
    if (!deck) throw new NotFoundError('deck not found');
    res.json(deck);
  });

  const spec: RequestHandler = asyncHandler(async (req, res) => {
    const id = deckId(req.params['id']);
    const ctx = await ctxFor(req, id);
    const found = await opts.spec(id, revisionId(req.params['rid']), ctx);
    if (!found) throw new NotFoundError('revision not found');
    res.json(found);
  });

  const save: RequestHandler = asyncHandler(async (req, res) => {
    const id = deckId(req.params['id']);
    const ctx = await ctxFor(req, id);
    if (opts.saveGuard) await opts.saveGuard(req, ctx, id);
    const result = await opts.save(id, (req.body ?? {}) as Record<string, unknown>, ctx, req);
    if (!result.ok) { sendFail(res, result); return; }
    res.status(201).json(result.value);
  });

  /** 201 when a revision was written, 200 for a replay or an edit that changed nothing. */
  const revise: RequestHandler = asyncHandler(async (req, res) => {
    if (!opts.revise) throw new NotFoundError('revise is not available for this deck');
    const id = deckId(req.params['id']);
    const ctx = await ctxFor(req, id);
    if (opts.saveGuard) await opts.saveGuard(req, ctx, id);
    const result = await opts.revise(id, (req.body ?? {}) as Record<string, unknown>, ctx, req);
    if (!result.ok) { sendFail(res, result); return; }
    res.status(result.value.revisionId && !result.value.replayed ? 201 : 200).json(result.value);
  });

  const preview: RequestHandler = asyncHandler(async (req, res) => {
    const id = deckId(req.params['id']);
    const ctx = await ctxFor(req, id);
    const result = await opts.preview(id, (req.body as { spec?: unknown } | undefined)?.spec, ctx);
    if (!result.ok) { sendFail(res, result); return; }
    res.json(result.value);
  });

  const file: RequestHandler = asyncHandler(async (req, res) => {
    const id = deckId(req.params['id']);
    const ctx = await ctxFor(req, id);
    const out = await opts.file(id, revisionId(req.params['rid']), ctx);
    if (!out) throw new NotFoundError('revision not found');
    sendPptx(res, out);
  });

  return { detail, spec, save, revise, preview, file, deckId, revisionId, ctxFor };
}

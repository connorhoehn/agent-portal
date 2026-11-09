// /api/access-requests — the in-tenant quick request (decided 2026-10-13).
//
// A reader who meets a locked figure asks for the access that opens it from
// where they are — the Work tenant's Initiatives table, a locked budget answer —
// without switching to the Access tenant (which they usually hold no grant in).
// The request it files is an ORDINARY access request: routes/access.ts
// `fileRequest` is the one submit path, so the chain (manager, then the item's
// steward), the SoD pre-check, the duplicate and already-held refusals, the
// rows, the events and the approvers' bell items are exactly the ones
// `POST /api/access/requests` writes. Approvers decide it in Access as usual;
// the last approval provisions; the grant reaches the requester's open cookie
// through the ≤120 s grants refresh (decision A3), so the figures appear
// without a sign-out.
//
// What makes it narrower than POST /api/access/requests:
//   * a session floor only — no `requireTenant('access')`, no RequestAccess:
//     the caller stands in their own tenant;
//   * the caller is always requester AND beneficiary (no beneficiaryId);
//   * only catalog items whose tenant is the caller's CURRENT tenant — a Work
//     session cannot file for an Assessment role from here (403) — and one
//     more: the Social role the embedded Social plane itself names as the way
//     to post here (GET /api/social/plane/capabilities `requestItemId`,
//     socialPostRequestItemId), since the plane is part of every workspace and
//     its refusal offers exactly that request (G10, voice G27);
//   * it never decides, withdraws or provisions anything.
// Wire shapes: docs/access-tenant-api.md "Quick request".

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireSession, resolveSession } from '../lib/authz.js';
import { envelopeItemId } from '../lib/access/items.js';
import { listCatalog } from '../providers/access.js';
import { bodyOf, context, fileRequest, ownRequestsFor, parseSubmission, type Ctx } from './access.js';
import { socialPostRequestItemId } from './social-plane.js';
import type { Request, Response } from 'express';

export const accessQuickRouter = Router();

accessQuickRouter.use(requireSession('QuickAccessRequest'));

/**
 * The catalog item `itemId`, refused unless it belongs to the caller's current tenant (or, with `planeItem`, is
 * the Social plane's own request item for this caller). Sends the refusal and returns null.
 */
async function itemInTenant(req: Request, res: Response, itemId: string, opts: { planeItem?: boolean } = {}): Promise<ReturnType<typeof listCatalog>[number] | null> {
  const session = resolveSession(req)!;
  const item = listCatalog().find((i) => i.id === itemId);
  if (!item) { res.status(400).json({ error: `Unknown catalog item: ${itemId}` }); return null; }
  if (item.tenant !== session.tenant && opts.planeItem && session.tenant !== 'social' && item.id === await socialPostRequestItemId(session.sub)) return item;
  if (item.tenant !== session.tenant) {
    res.status(403).json({ error: `${item.title} belongs to another workspace; request it from there, or in Access` });
    return null;
  }
  return item;
}

/** The caller as a directory user, or a 403 when the session has no directory row (the cookie-less demo persona). */
async function requesterContext(res: Response, req: Request): Promise<Ctx | null> {
  const ctx = await context(req);
  if (!ctx.self) {
    res.status(403).json({ error: NO_ACCOUNT_REASON });
    return null;
  }
  return ctx;
}

// POST /api/access-requests/quick  { itemId, justification, duration }
accessQuickRouter.post('/quick', asyncHandler(async (req, res) => {
  const sub = parseSubmission(bodyOf(req, ['itemId', 'justification', 'duration']));
  if (!await itemInTenant(req, res, sub.itemId, { planeItem: true })) return;
  const ctx = await requesterContext(res, req);
  if (!ctx) return;
  const out = await fileRequest(ctx, { itemId: sub.itemId, justification: sub.justification, duration: sub.duration });
  res.status(out.status).json(out.body);
}));

// POST /api/access-requests/envelope  { initiativeId, justification, requestedUsd, forecast?, duration? }
//
// The dispatch drawer's "Request budget" (2026-10-28): an SME refused by the
// grant-scoped dispatch gate ("no active sprint grant") files an ORDINARY
// request for the initiative's derived `envelope:<initiativeId>` item through
// `fileRequest`, carrying their message, the amount and the forecast they were
// looking at. The chain, the refusals, the rows and the bells are the catalog
// path's; the last approval provisions a budget_grants row through the same
// path POST /api/grants takes (lib/grant-envelope.ts). `duration` defaults to
// the item's (`standing`): the envelope lives until it is revoked, like one
// granted by hand.
accessQuickRouter.post('/envelope', asyncHandler(async (req, res) => {
  const b = bodyOf(req, ['initiativeId', 'justification', 'requestedUsd', 'forecast', 'duration']);
  const initiativeId = typeof b['initiativeId'] === 'string' ? b['initiativeId'].trim() : '';
  if (!initiativeId) throw new ValidationError('initiativeId is required');
  const itemId = envelopeItemId(initiativeId);
  const item = await itemInTenant(req, res, itemId);
  if (!item) return;
  const sub = parseSubmission({
    itemId, justification: b['justification'], duration: b['duration'] ?? item.defaultDuration,
    requestedUsd: b['requestedUsd'], ...(b['forecast'] !== undefined ? { forecast: b['forecast'] } : {}),
  });
  if (sub.requestedUsd == null) throw new ValidationError('requestedUsd is required: the dollars the envelope should hold');
  const ctx = await requesterContext(res, req);
  if (!ctx) return;
  const out = await fileRequest(ctx, sub);
  res.status(out.status).json(out.body);
}));

// GET /api/access-requests/mine?itemId=  → { items: AccessRequest[] }, newest first
accessQuickRouter.get('/mine', asyncHandler(async (req, res) => {
  // A session with no directory row (the cookie-less demo persona) has filed nothing, so it is answered
  // `{ items: [], requestable: false, reason }` rather than a 403: the read is "your requests for this item",
  // and every caller (the Initiatives budget header, a page this role cannot open, voice access_request_status)
  // reads an empty list as "none filed" and `requestable: false` as "do not offer the form" (UX walk,
  // 9 November 2026). Filing (POST /quick) still refuses such a session with the same reason.
  const unknown = Object.keys(req.query).filter((k) => k !== 'itemId');
  if (unknown.length) { res.status(400).json({ error: `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` }); return; }
  const itemId = typeof req.query['itemId'] === 'string' ? req.query['itemId'].trim() : '';
  if (!itemId) { res.status(400).json({ error: 'itemId is required' }); return; }
  if (!await itemInTenant(req, res, itemId, { planeItem: true })) return;
  const ctx = await context(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!ctx.self) { res.json({ items: [], requestable: false, reason: NO_ACCOUNT_REASON }); return; }
  res.json({ items: ownRequestsFor(ctx, itemId) });
}));

/** Why a session with no directory row cannot file a request (POST refuses it; GET /mine says so). */
export const NO_ACCOUNT_REASON = 'Sign in as a directory user to request access; this session has no account to grant it to';

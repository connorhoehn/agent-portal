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
//     session cannot file for an Assessment role from here (403);
//   * it never decides, withdraws or provisions anything.
// Wire shapes: docs/access-tenant-api.md "Quick request".

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { requireSession, resolveSession } from '../lib/authz.js';
import { listCatalog } from '../providers/access.js';
import { bodyOf, context, fileRequest, ownRequestsFor, parseSubmission, type Ctx } from './access.js';
import type { Request, Response } from 'express';

export const accessQuickRouter = Router();

accessQuickRouter.use(requireSession('QuickAccessRequest'));

/** The catalog item `itemId`, refused unless it belongs to the caller's current tenant. Sends the refusal and returns null. */
function itemInTenant(req: Request, res: Response, itemId: string): ReturnType<typeof listCatalog>[number] | null {
  const session = resolveSession(req)!;
  const item = listCatalog().find((i) => i.id === itemId);
  if (!item) { res.status(400).json({ error: `Unknown catalog item: ${itemId}` }); return null; }
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
    res.status(403).json({ error: 'Sign in as a directory user to request access; this session has no account to grant it to' });
    return null;
  }
  return ctx;
}

// POST /api/access-requests/quick  { itemId, justification, duration }
accessQuickRouter.post('/quick', asyncHandler(async (req, res) => {
  const sub = parseSubmission(bodyOf(req, ['itemId', 'justification', 'duration']));
  if (!itemInTenant(req, res, sub.itemId)) return;
  const ctx = await requesterContext(res, req);
  if (!ctx) return;
  const out = await fileRequest(ctx, { itemId: sub.itemId, justification: sub.justification, duration: sub.duration });
  res.status(out.status).json(out.body);
}));

// GET /api/access-requests/mine?itemId=  → { items: AccessRequest[] }, newest first
accessQuickRouter.get('/mine', asyncHandler(async (req, res) => {
  const unknown = Object.keys(req.query).filter((k) => k !== 'itemId');
  if (unknown.length) { res.status(400).json({ error: `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}` }); return; }
  const itemId = typeof req.query['itemId'] === 'string' ? req.query['itemId'].trim() : '';
  if (!itemId) { res.status(400).json({ error: 'itemId is required' }); return; }
  if (!itemInTenant(req, res, itemId)) return;
  const ctx = await requesterContext(res, req);
  if (!ctx) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: ownRequestsFor(ctx, itemId) });
}));

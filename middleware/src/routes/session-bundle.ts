// Session bundles — /api/session-bundle. What every devbox is configured
// with, and the one write: publish a pending bundle to the fleet.
//
// Reads are open to the tenant — seeing what a running session was told is
// not a mutation. Publish sits behind ManageDevbox: it is the same authority
// that already governs everything else that reaches a running box, and here
// it governs a hook that runs on every session start, fleet-wide.

import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import {
  listBundles, getLiveBundle, getBundle, publishBundle, sessionsAffected,
  type SessionBundle,
} from '../providers/session-bundle.js';
import { listBoxes } from '../lib/devbox-fleet.js';

export const sessionBundleRouter: Router = Router();

const publishGate = requireAction('ManageDevbox');

// "Publishing blind" is the failure mode sessionsAffected exists to prevent
// (see providers/session-bundle.ts) — so every single-bundle read carries the
// live count against the CURRENT fleet, not just the bundle's own fields.
function withImpact(bundle: SessionBundle): SessionBundle & { sessionsAffected: number } {
  return { ...bundle, sessionsAffected: sessionsAffected(bundle, listBoxes()) };
}

// GET /api/session-bundle — every bundle, newest first
sessionBundleRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ bundles: (await listBundles()).map(withImpact) });
}));

// GET /api/session-bundle/live — what the fleet is running right now.
// `null` when nothing has been published yet. "Nothing is live" is an answer
// to "what is live?", not a missing resource — as a 404 it reached Session
// settings as an outage ("Could not load … unknown rather than empty") and
// hid the page's own empty state. `/:id` still 404s: there the caller named
// a bundle that does not exist.
sessionBundleRouter.get('/live', asyncHandler(async (_req, res) => {
  const bundle = await getLiveBundle();
  res.json(bundle ? withImpact(bundle) : null);
}));

// GET /api/session-bundle/:id
sessionBundleRouter.get('/:id', asyncHandler(async (req, res) => {
  const bundle = await getBundle(String(req.params['id'] ?? ''));
  if (!bundle) throw new NotFoundError('session bundle not found');
  res.json(withImpact(bundle));
}));

// POST /api/session-bundle/:id/publish {dryRunBoxId?}
//
// The signed-in operator is the approver — ManageDevbox already gates who can
// reach this route, and naming them here is what decidePublish checks for.
// `hasHooks` (did the dry run confirm the hook fired, not merely that a box
// was picked) has no box-telemetry source yet, so a supplied dryRunBoxId is
// today's proxy; wiring real dry-run confirmation is a TODO, not a shortcut
// decidePublish itself takes.
sessionBundleRouter.post('/:id/publish', publishGate, asyncHandler(async (req, res) => {
  const { dryRunBoxId } = (req.body ?? {}) as { dryRunBoxId?: string };
  const boxId = dryRunBoxId ? String(dryRunBoxId).trim() : null;
  const session = resolveSession(req);

  const result = await publishBundle(String(req.params['id'] ?? ''), {
    approvedBy: session?.name ?? session?.sub ?? null,
    dryRunBoxId: boxId,
    hasHooks: boxId != null,
  });
  if (!result) throw new NotFoundError('session bundle not found');
  if (!result.ok) { res.status(409).json({ error: result.reason }); return; }
  res.json(withImpact(result.bundle));
}));

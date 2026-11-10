// Session bundles — /api/session-bundle/live: what every devbox is configured
// with. Read-open to the tenant.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { getLiveBundle, sessionsAffected, type SessionBundle } from '../providers/session-bundle.js';
import { listBoxes } from '../lib/devbox-fleet.js';

export const sessionBundleRouter: Router = Router();

// The read carries the live count against the CURRENT fleet.
function withImpact(bundle: SessionBundle): SessionBundle & { sessionsAffected: number } {
  return { ...bundle, sessionsAffected: sessionsAffected(bundle, listBoxes()) };
}

// GET /api/session-bundle/live — what the fleet is running right now.
// `null` when nothing has been published yet. "Nothing is live" is an answer
// to "what is live?", not a missing resource — as a 404 it reached Session
// settings as an outage ("Could not load … unknown rather than empty") and
// hid the page's own empty state.
sessionBundleRouter.get('/live', asyncHandler(async (_req, res) => {
  const bundle = await getLiveBundle();
  res.json(bundle ? withImpact(bundle) : null);
}));

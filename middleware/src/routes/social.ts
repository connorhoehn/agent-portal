// /api/social — the social tenant's API (docs/social-tenant-design.md §4).
//
// Mounted in index.ts as `app.use('/api/social', requireTenant('social'), …)`:
// the tenant has no machine callback of its own, so the data boundary sits at
// the mount (a session parked in orgiq or assessment is refused with 403
// before any handler runs; the cross-tenant admin passes). Reads are gated on
// `ViewSocial`, which every social role holds.
//
// Phase S0 serves one route, `GET /summary`, so the mount is real and the
// gate is exercised; channels and DMs (`POST /channels`, `POST /dms`) arrive
// in S1, rooms/teams/recordings in S2, bindings in E.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { ROLES_BY_TENANT } from '../lib/session.js';
import { tenantMembers, type TenantSummary } from '../lib/tenant-summary.js';
import { socialSurfaceCounts, socialSurfaces } from '../mock/social.js';

export const socialRouter = Router();

socialRouter.get('/summary', requireAction('ViewSocial'), asyncHandler(async (_req, res) => {
  const body: TenantSummary = {
    tenant: 'social',
    members: await tenantMembers('social', ROLES_BY_TENANT.social),
    surfaces: socialSurfaceCounts(socialSurfaces.rows()),
  };
  res.json(body);
}));

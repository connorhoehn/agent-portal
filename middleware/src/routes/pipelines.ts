// /api/pipelines — the pipelines tenant's API (docs/social-tenant-design.md §5,
// docs/pipelines-tenant-goal.md).
//
// Mounted in index.ts as `app.use('/api/pipelines', requireTenant('pipelines'), …)`
// — at the mount, since the tenant has no machine callback of its own. Reads
// are gated on `ViewPipelines`, which every pipelines role holds.
//
// The registration half of lane P0 serves `GET /summary` so the mount is real
// and the gate is exercised. The run projection's routes (`/runs`,
// `/runs/:id`, `/runs/:id/steps`, `/runs/:id/events`) are the other half of
// P0; definitions and approvals are P2.

import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { ROLES_BY_TENANT } from '../lib/session.js';
import { tenantMembers, type TenantSummary } from '../lib/tenant-summary.js';
import { pipelinesSurfaceCounts, pipelinesSurfaces } from '../mock/pipelines.js';

export const pipelinesRouter = Router();

pipelinesRouter.get('/summary', requireAction('ViewPipelines'), asyncHandler(async (_req, res) => {
  const body: TenantSummary = {
    tenant: 'pipelines',
    members: await tenantMembers('pipelines', ROLES_BY_TENANT.pipelines),
    surfaces: pipelinesSurfaceCounts(pipelinesSurfaces.rows()),
  };
  res.json(body);
}));

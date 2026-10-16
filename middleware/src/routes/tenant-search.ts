// GET /api/<tenant>/search?q=&limit=&type= for assessment, social, pipelines and
// access (docs/user-search-goal.md S2). Each is mounted behind the tenant's own
// gate (index.ts), reads the tenant's SearchIndex partition, and answers the
// palette's record section. The orgiq tenant keeps GET /api/search.
import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { resolveSession } from '../lib/authz.js';
import { searchTenant } from '../lib/search-index/tenant-query.js';
import type { IndexedTenant } from '../lib/search-index/tenants.js';

export function tenantSearchRouter(tenant: Exclude<IndexedTenant, 'orgiq'>): Router {
  const router = Router();
  // Participant-private records (a DM, a request) must never enter a shared cache.
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/', asyncHandler(async (req, res) => {
    const q = String(req.query['q'] ?? '').trim();
    if (q.length > 500) throw new ValidationError('q must be 500 characters or fewer');
    const limit = Number(req.query['limit'] ?? 8);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ValidationError('limit must be an integer between 1 and 50');
    const type = String(req.query['type'] ?? 'all');
    res.json(await searchTenant(tenant, resolveSession(req)!, { q, limit, type }));
  }));
  return router;
}

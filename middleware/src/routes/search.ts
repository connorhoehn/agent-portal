import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireTenant, resolveSession } from '../lib/authz.js';
import { SEARCH_TYPES, searchRecords, resolveSearchContext, type SearchRecordType, type SearchRef } from '../providers/search.js';

export const searchRouter = Router();
searchRouter.use(requireTenant('orgiq'), requireAction('Search'));
searchRouter.get('/', asyncHandler(async (req, res) => {
  const q = String(req.query['q'] ?? '').trim();
  const type = String(req.query['type'] ?? 'all');
  const scope = String(req.query['scope'] ?? '').trim();
  if (q.length > 1000) throw new ValidationError('q must be 1000 characters or fewer');
  if (type !== 'all' && !SEARCH_TYPES.includes(type as SearchRecordType)) throw new ValidationError('Unknown search type');
  const limit = Number(req.query['limit'] ?? 50), offset = Number(req.query['offset'] ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be an integer between 1 and 100');
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError('offset must be a nonnegative integer');
  res.json(await searchRecords(resolveSession(req)!, { q, type: type as SearchRecordType | 'all', scope: !scope || scope === 'workspace' ? undefined : scope, limit, offset }));
}));

// Resolve explicit graph/context selection even when it is outside the current
// result page. Canonical record fields and permissions are re-read server-side.
searchRouter.get('/records', asyncHandler(async (req, res) => {
  const raw = String(req.query['keys'] ?? '');
  const keys = raw ? raw.split(',') : [];
  if (keys.length > 30) throw new ValidationError('Select at most 30 records');
  const refs: SearchRef[] = keys.map(key => {
    const colon = key.indexOf(':');
    const type = key.slice(0, colon) as SearchRecordType, id = key.slice(colon + 1);
    if (colon < 1 || !SEARCH_TYPES.includes(type) || !id || id.length > 200) throw new ValidationError('Invalid record key');
    return { type, id };
  });
  res.json(await resolveSearchContext(resolveSession(req)!, refs));
}));

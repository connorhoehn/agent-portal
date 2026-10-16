import { Router } from 'express';
import { asyncHandler, AppError, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireTenant, resolveSession } from '../lib/authz.js';
import { recordUserId } from '../lib/record-owner.js';
import { createSavedSearch, deleteSavedSearch, listSavedSearches, updateSavedSearch, type SavedSearchInput } from '../providers/saved-searches.js';

export const savedSearchesRouter = Router();
savedSearchesRouter.use(requireTenant('orgiq'), requireAction('Search'));
const TYPES = new Set(['person', 'initiative', 'work', 'decision', 'knowledge', 'asset', 'recording']);
const TABS = new Set(['results', 'answer', 'connections']);
function text(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new ValidationError(`${field} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters`);
  return value;
}
function validate(raw: unknown, partial = false): Partial<SavedSearchInput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Expected a saved search object');
  const input = raw as Record<string, unknown>;
  const result: Partial<SavedSearchInput> = {};
  for (const key of Object.keys(input)) if (!['name', 'query', 'scope', 'types', 'tab', 'selectedKeys'].includes(key)) throw new ValidationError(`Unknown field: ${key}`);
  if (!partial || input['name'] !== undefined) result.name = text(input['name'], 'name', 120).trim();
  if (!partial || input['query'] !== undefined) result.query = text(input['query'], 'query', 2000, true);
  if (!partial || input['scope'] !== undefined) {
    result.scope = text(input['scope'] ?? 'workspace', 'scope', 256);
  }
  if (!partial || input['tab'] !== undefined) {
    const tab = input['tab'] ?? 'results';
    if (typeof tab !== 'string' || !TABS.has(tab)) throw new ValidationError('Invalid tab');
    result.tab = tab as SavedSearchInput['tab'];
  }
  if (!partial || input['types'] !== undefined) {
    const types = input['types'] ?? [];
    if (!Array.isArray(types) || types.length > TYPES.size || !types.every(type => typeof type === 'string' && TYPES.has(type))) throw new ValidationError('Invalid record types');
    result.types = [...new Set(types as string[])];
  }
  if (!partial || input['selectedKeys'] !== undefined) {
    const keys = input['selectedKeys'] ?? [];
    if (!Array.isArray(keys) || keys.length > 50 || !keys.every(key => typeof key === 'string' && key.length <= 280 && /^(person|initiative|work|decision|knowledge|asset|recording):[^\s]+$/.test(key))) throw new ValidationError('selectedKeys must contain at most 50 typed record keys');
    result.selectedKeys = [...new Set(keys as string[])];
  }
  if (partial && !Object.keys(result).length) throw new ValidationError('No changes supplied');
  return result;
}
function owner(req: Parameters<typeof resolveSession>[0]) {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Unauthenticated');
  // A clone's saved searches are its persona's (lib/record-owner.ts).
  return { sub: recordUserId(session.sub), tenant: session.tenant };
}
savedSearchesRouter.get('/', asyncHandler(async (req, res) => res.json({ searches: await listSavedSearches(owner(req)) })));
savedSearchesRouter.post('/', asyncHandler(async (req, res) => res.status(201).json({ search: await createSavedSearch(owner(req), validate(req.body) as SavedSearchInput) })));
savedSearchesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const search = await updateSavedSearch(owner(req), String(req.params['id']), validate(req.body, true));
  if (!search) throw new NotFoundError('Saved search not found');
  res.json({ search });
}));
savedSearchesRouter.delete('/:id', asyncHandler(async (req, res) => {
  if (!await deleteSavedSearch(owner(req), String(req.params['id']))) throw new NotFoundError('Saved search not found');
  res.status(204).end();
}));

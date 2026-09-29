jest.mock('../../lib/authz.js', () => ({
  requireTenant: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  requireAction: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  resolveSession: jest.fn(() => ({ sub: 'person', tenant: 'orgiq', role: 'member' })),
}));
jest.mock('../../providers/search.js', () => ({
  SEARCH_TYPES: ['person', 'initiative', 'work', 'decision', 'knowledge', 'asset'],
  SEARCH_SORTS: ['relevance', 'recent'],
  resolveSearchContext: jest.fn(async (_p, refs) => ({ records: refs, edges: [] })),
  searchRecords: jest.fn(async (_p, opts) => ({ query: opts.q, results: [], total: 0, counts: {}, related: [], edges: [] })),
}));
import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant, requireAction } from '../../lib/authz.js';
import { searchRecords } from '../../providers/search.js';
import { searchRouter } from '../search.js';
const app = express(); app.use('/api/search', searchRouter); app.use(errorHandler);
test('search is mounted behind the tenant boundary and Search authority', () => {
  expect(requireTenant).toHaveBeenCalledWith('orgiq'); expect(requireAction).toHaveBeenCalledWith('Search');
});
test.each(['type=unrecognized', 'limit=0', 'limit=101', 'limit=1.5', 'offset=-1', 'offset=nope', 'sort=bogus', 'sort='])('rejects unsupported query %s', async query => {
  expect((await request(app).get(`/api/search?${query}`)).status).toBe(400);
});
test('passes initiative scope, type and pagination through', async () => {
  const response = await request(app).get('/api/search?q=Auth&type=person&scope=p-auth&limit=20&offset=10');
  expect(response.status).toBe(200);
  expect(searchRecords).toHaveBeenLastCalledWith(expect.objectContaining({ tenant: 'orgiq' }), { q: 'Auth', type: 'person', scope: 'p-auth', limit: 20, offset: 10, sort: 'relevance' });
});
test('sort=recent reaches the provider; relevance is the default', async () => {
  expect((await request(app).get('/api/search?q=Auth&sort=recent')).status).toBe(200);
  expect(searchRecords).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ sort: 'recent' }));
  expect((await request(app).get('/api/search?q=Auth')).status).toBe(200);
  expect(searchRecords).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ sort: 'relevance' }));
});
test('workspace scope is the whole authorized workspace', async () => {
  expect((await request(app).get('/api/search?scope=workspace')).status).toBe(200);
  expect(searchRecords).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ scope: undefined }));
});

test('resolves selected existing record keys outside the current search page', async () => {
  const r = await request(app).get('/api/search/records?keys=person:nora,work:cutover');
  expect(r.status).toBe(200);
  expect(r.body.records).toEqual([{ type: 'person', id: 'nora' }, { type: 'work', id: 'cutover' }]);
});
test.each(['unknown:id', 'person:', 'missingtype'])('rejects malformed record key %s', async key => {
  expect((await request(app).get(`/api/search/records?keys=${key}`)).status).toBe(400);
});

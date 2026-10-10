jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session,
  requireTenant: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
import express from 'express';
import request from '../../test-support/http.js';
import { savedSearchesRouter } from '../saved-searches.js';
import { savedSearchesFixture } from '../../providers/saved-searches.js';
import { errorHandler } from '../../lib/async-handler.js';
const app = express(); app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: String(req.headers['x-user'] ?? 'user-a'), tenant: 'orgiq' }; next(); });
app.use('/api/saved-searches', savedSearchesRouter); app.use(errorHandler);
beforeEach(() => savedSearchesFixture.rows().splice(0));
it('saves recording refs only as a definition, never artifact text or authority', async () => {
  const saved = await request(app).post('/api/saved-searches').send({ name: 'Call evidence', query: 'budget', types: ['recording'], selectedKeys: ['recording:rec-native'] });
  expect(saved.status).toBe(201);
  expect(saved.body.search).toMatchObject({ types: ['recording'], selectedKeys: ['recording:rec-native'] });
  expect((await request(app).post('/api/saved-searches').send({ name: 'Leak', query: 'budget', transcript: 'private body' })).status).toBe(400);
});
it('creates/reopens/renames/deletes definitions scoped to current user', async () => {
  const created = await request(app).post('/api/saved-searches').send({ name: 'Auth', query: 'Who helps?', scope: 'p-auth' });
  expect(created.status).toBe(201); const id = created.body.search.id;
  expect((await request(app).get('/api/saved-searches')).body.searches).toHaveLength(1);
  expect((await request(app).get('/api/saved-searches').set('x-user', 'user-b')).body.searches).toHaveLength(0);
  expect((await request(app).patch(`/api/saved-searches/${id}`).set('x-user', 'user-b').send({ name: 'Wrong' })).status).toBe(404);
  expect((await request(app).patch(`/api/saved-searches/${id}`).send({ name: 'Updated', tab: 'connections' })).body.search.name).toBe('Updated');
  expect((await request(app).delete(`/api/saved-searches/${id}`)).status).toBe(204);
});
it.each([{ name: '', query: 'x' }, { name: 'a', query: 'x', ownerSub: 'other' }, { name: 'a', query: 'x', selectedKeys: ['broken'] }, { name: 'a', query: 'x', tab: 'bogus' }, { name: 'a', query: 'x', types: ['admin'] }])('rejects invalid or authority-bearing fields %p', async input => {
  expect((await request(app).post('/api/saved-searches').send(input)).status).toBe(400);
});

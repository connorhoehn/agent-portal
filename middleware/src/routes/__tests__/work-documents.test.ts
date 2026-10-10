jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { workDocumentsRouter } from '../work-documents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { getWorkItem } from '../../providers/work-items.js';
import { kbDocumentRows } from '../../mock/knowledge-base.js';
import { workDocumentLinks } from '../../providers/work-documents.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';

const WORK = 'wi-auth-e2-b3', DOC = 'postmortem-p-auth-migration';
const session: Session = { sub: 'author', tenant: 'orgiq', role: 'org-leader', epoch: 0, iat: 1, grants: { orgiq: ['org-leader'] } };
let users: Map<string, UserInfo>, sessions: Map<string, Session>;
let app: express.Express;
const url = `/api/graph/work-items/${WORK}/documents`;
const read = () => request(app).get(`/api/graph/work-items/${WORK}/documents`).set('x-user', 'author');
const link = () => request(app).put(`/api/graph/work-items/${WORK}/documents/${DOC}`).set('x-user', 'author');
beforeEach(() => {
  jest.clearAllMocks(); workDocumentLinks.reset('default'); kbDocumentRows.reset('default');
  users = new Map([['author', { id: 'author', epoch: 0, grants: { orgiq: ['org-leader'] }, displayName: 'Author', email: null, personId: null }],
    ['reader', { id: 'reader', epoch: 0, grants: { orgiq: ['member'] }, displayName: 'Reader', email: null, personId: null }]]);
  sessions = new Map([['author', session], ['reader', { ...session, sub: 'reader', role: 'member', grants: { orgiq: ['member'] } }]]);
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => principal.role === 'org-leader' && action === 'DispatchAgentRun');
  jest.mocked(getWorkItem).mockImplementation(async id => id === WORK ? { id, projectId: 'p-auth-migration' } as Awaited<ReturnType<typeof getWorkItem>> : null);
  app = express(); app.use(express.json()); app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
  app.use('/api/graph', workDocumentsRouter); app.use(errorHandler);
});
it('saves only the canonical association, preserves duplicate attribution and resolves current document metadata on read', async () => {
  expect((await read()).body.documents).toEqual([]);
  const created = await link(); expect(created.status).toBe(201); expect(created.body).toEqual({ workItemId: WORK, documentId: DOC, created: true });
  const stored = structuredClone(workDocumentLinks.rows());
  expect(stored).toHaveLength(1); expect(Object.keys(stored[0]!).sort()).toEqual(['documentId', 'linkedAt', 'linkedBy', 'workItemId']);
  expect((await link()).body.created).toBe(false); expect(workDocumentLinks.rows()).toEqual(stored);
  const doc = kbDocumentRows.rows().find(row => row.id === DOC)!; doc.title = 'Renamed canonical postmortem';
  const result = await read(); expect(result.headers['cache-control']).toBe('no-store');
  expect(result.body.documents[0]).toMatchObject({ id: DOC, title: doc.title, href: `/iq/documents/${DOC}`, linkedBy: 'author' });
  expect((await request(app).get(`/api/graph/documents/${DOC}`).set('x-user', 'reader')).body.title).toBe(doc.title);
});
it('unlinks without deleting the document and observes missing resources', async () => {
  await link(); const response = await request(app).delete(`/api/graph/work-items/${WORK}/documents/${DOC}`).set('x-user', 'author');
  expect(response.body.removed).toBe(true); expect((await read()).body.documents).toEqual([]);
  expect((await request(app).get(`/api/graph/documents/${DOC}`).set('x-user', 'reader')).status).toBe(200);
  await link(); kbDocumentRows.rows().splice(kbDocumentRows.rows().findIndex(row => row.id === DOC), 1);
  expect((await read()).body.documents).toEqual([]); expect((await link()).status).toBe(404);
  expect((await request(app).get(`/api/graph/documents/${DOC}`).set('x-user', 'reader')).status).toBe(404);
});
it('searches canonical corpus records and denies malformed, missing, forged and anonymous requests', async () => {
  const result = await request(app).get(`/api/graph/work-items/${WORK}/documents/candidates`).query({ q: 'auth token' }).set('x-user', 'author');
  expect(result.status).toBe(200); expect(result.body.documents.map((doc: { id: string }) => doc.id)).toContain(DOC);
  expect((await request(app).put(`${url}/${DOC}`).set('x-user', 'author').send({ title: 'Forged', linkedBy: 'reader' })).status).toBe(400);
  expect((await request(app).get(url)).status).toBe(401);
  expect((await request(app).get('/api/graph/work-items/missing/documents').set('x-user', 'author')).status).toBe(404);
  expect((await request(app).get('/api/graph/documents/invalid%20id').set('x-user', 'author')).status).toBe(400);
  expect((await request(app).get(`${url}/candidates`).query({ q: 'x'.repeat(201) }).set('x-user', 'author')).status).toBe(400);
  expect(workDocumentLinks.rows()).toEqual([]);
});
it('allows tenant readers without mutation controls and checks source tenant, epoch and masquerade authority', async () => {
  expect((await request(app).get(url).set('x-user', 'reader')).status).toBe(200);
  expect((await request(app).put(`${url}/${DOC}`).set('x-user', 'reader')).status).toBe(403);
  sessions.set('author', { ...session, tenant: 'social', role: 'participant', grants: { social: ['participant'] } });
  users.get('author')!.grants.social = ['participant']; expect((await read()).status).toBe(403);
  sessions.set('author', session); users.get('author')!.epoch = 1; expect((await read()).status).toBe(401);
  users.get('author')!.epoch = 0; sessions.set('author', { ...session, act: { ...session, sub: 'reader' } });
  expect((await read()).status).toBe(401); expect(workDocumentLinks.rows()).toEqual([]);
});
it.each(['read', 'write'])('fences a delayed %s when the source role is revoked', async operation => {
  let release!: () => void, entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  jest.mocked(getWorkItem).mockImplementationOnce(async () => { entered(); await wait; return { id: WORK } as Awaited<ReturnType<typeof getWorkItem>>; });
  const pending = (operation === 'read' ? read() : link()).then(result => result); await began;
  users.get('author')!.grants.orgiq = []; release(); const response = await pending;
  expect(response.status).toBe(401); expect(response.body.documents).toBeUndefined(); expect(workDocumentLinks.rows()).toEqual([]);
});

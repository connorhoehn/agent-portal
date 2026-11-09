jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../lib/initiative-scope.js', () => ({ requireInitiativeScope: jest.fn(), stewardsInitiative: jest.fn(async () => true) }));
jest.mock('../../lib/work-graph/live.js', () => ({ notifyWorkGraphChanged: jest.fn(async () => {}) }));
import express from 'express';
import request from '../../test-support/http.js';
import { workDocumentsRouter } from '../work-documents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { getWorkItem } from '../../providers/work-items.js';
import { getProject } from '../../providers/projects.js';
import { requireInitiativeScope } from '../../lib/initiative-scope.js';
import { notifyWorkGraphChanged } from '../../lib/work-graph/live.js';
import { workspaceDocuments } from '../../providers/work-documents.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';

// The Docs tab's "New › Document" and the page it opens (2026-11-02): a page
// written inside an initiative, stored apart from the linked corpus records.
const PROJECT = 'p-auth-migration', WORK = 'wi-auth-e2-b3';
const session: Session = { sub: 'author', tenant: 'orgiq', role: 'org-leader', epoch: 0, iat: 1, grants: { orgiq: ['org-leader'] } };
let app: express.Express;
const as = (user: string) => ({ 'x-user': user });
const list = (user = 'author') => request(app).get(`/api/graph/projects/${PROJECT}/workspace-documents`).set(as(user));
const create = (body: unknown, user = 'author') => request(app).post(`/api/graph/projects/${PROJECT}/workspace-documents`).set(as(user)).send(body as object);
beforeEach(() => {
  jest.clearAllMocks(); workspaceDocuments.reset(); workspaceDocuments.rows().splice(0);
  const users = new Map<string, UserInfo>([
    ['author', { id: 'author', epoch: 0, grants: { orgiq: ['org-leader'] }, displayName: 'Author', email: null, personId: null }],
    ['reader', { id: 'reader', epoch: 0, grants: { orgiq: ['member'] }, displayName: 'Reader', email: null, personId: null }]]);
  const sessions = new Map<string, Session>([['author', session], ['reader', { ...session, sub: 'reader', role: 'member', grants: { orgiq: ['member'] } }]]);
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  // G56: pages and whiteboards are written with ViewWorkItems (+ the initiative's own people, mocked here); this member holds neither.
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => principal.role === 'org-leader' && (action === 'DispatchAgentRun' || action === 'ViewWorkItems'));
  jest.mocked(getProject).mockImplementation(async id => id === PROJECT ? { id, name: 'Auth Migration' } as Awaited<ReturnType<typeof getProject>> : null);
  jest.mocked(getWorkItem).mockImplementation(async id => id === WORK ? { id, projectId: PROJECT } as Awaited<ReturnType<typeof getWorkItem>> : null);
  jest.mocked(requireInitiativeScope).mockResolvedValue(true);
  app = express(); app.use(express.json()); app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
  app.use('/api/graph', workDocumentsRouter); app.use(errorHandler);
});
it('creates a page in the initiative, lists it newest first, reads it back by id with its body, and edits it', async () => {
  expect((await list()).body).toEqual({ projectId: PROJECT, documents: [], canWrite: true });
  expect((await list('reader')).body.canWrite).toBe(false);
  const created = await create({ title: '  Cutover runbook  ', workItemId: WORK });
  expect(created.status).toBe(201);
  const doc = created.body.document;
  expect(doc).toMatchObject({ projectId: PROJECT, workItemId: WORK, title: 'Cutover runbook', kind: 'page', markdown: '', createdBy: 'author' });
  expect(doc.href).toBe(`/iq/documents/${doc.id}`);
  expect(jest.mocked(notifyWorkGraphChanged)).toHaveBeenCalledWith(PROJECT, 'work-document');
  const second = (await create({ title: 'Second' })).body.document;
  expect((await list()).body.documents.map((d: { id: string }) => d.id)).toEqual([second.id, doc.id].sort((a, b) => a === second.id ? -1 : 1));
  const read = await request(app).get(`/api/graph/documents/${doc.id}`).set(as('reader'));
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({ id: doc.id, title: 'Cutover runbook', source: 'workspace', sourceUri: null, markdown: '', kind: 'page', ingestedAt: doc.createdAt });
  const edited = await request(app).put(`/api/graph/documents/${doc.id}`).set(as('author')).send({ markdown: '# Plan\n\nTenant by tenant.' });
  expect(edited.status).toBe(200); expect(edited.body.document.markdown).toBe('# Plan\n\nTenant by tenant.');
  expect((await request(app).get(`/api/graph/documents/${doc.id}`).set(as('reader'))).body.markdown).toBe('# Plan\n\nTenant by tenant.');
});
it('creates a whiteboard and round-trips its scene, refusing a scene that is not base64', async () => {
  const created = await create({ title: 'Cutover board', kind: 'whiteboard' });
  expect(created.status).toBe(201); expect(created.body.document).toMatchObject({ kind: 'whiteboard', scene: '', markdown: '' });
  const id = created.body.document.id as string;
  expect((await request(app).put(`/api/graph/documents/${id}`).set(as('author')).send({ scene: 'AQID' })).status).toBe(200);
  expect((await request(app).get(`/api/graph/documents/${id}`).set(as('reader'))).body).toMatchObject({ kind: 'whiteboard', scene: 'AQID' });
  expect((await request(app).put(`/api/graph/documents/${id}`).set(as('author')).send({ scene: 'not base64!' })).status).toBe(400);
  expect((await request(app).put(`/api/graph/documents/${id}`).set(as('reader')).send({ scene: 'AQID' })).status).toBe(403);
});
it('refuses a member, a foreign work item, a bad body and an unknown kind, and answers 404 for an unknown page', async () => {
  expect((await create({ title: 'Nope' }, 'reader')).status).toBe(403);
  expect((await create({ title: 'Nope', workItemId: 'wi-elsewhere' })).status).toBe(404);
  expect((await create({ title: '' })).status).toBe(400);
  expect((await create({ title: 'x', url: 'https://example.com' })).status).toBe(400);
  expect((await create({ title: 'Board', kind: 'deck' })).status).toBe(400);
  expect((await request(app).put('/api/graph/documents/wdoc-missing').set(as('author')).send({ title: 'x' })).status).toBe(404);
  expect((await request(app).put('/api/graph/documents/wdoc-missing').set(as('author')).send({})).status).toBe(400);
  expect(workspaceDocuments.rows()).toEqual([]);
});
it('asks the initiative scope before writing, and writes nothing when it refuses', async () => {
  jest.mocked(requireInitiativeScope).mockImplementation(async (_req, res) => { (res as { status: (n: number) => { json: (b: unknown) => void } }).status(403).json({ error: 'not a steward' }); return false; });
  expect((await create({ title: 'Nope' })).status).toBe(403);
  expect(workspaceDocuments.rows()).toEqual([]);
});

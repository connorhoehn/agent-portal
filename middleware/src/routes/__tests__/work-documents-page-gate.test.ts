// G56: who writes a page or a whiteboard in an initiative. The initiative's own
// people (owner, contributor, or an org-wide role: the REAL lib/initiative-scope.ts
// rule, over mocked directory and initiative rows) with ViewWorkItems, and no
// agent-run grant: a contributor who cannot dispatch agents still writes pages,
// a stranger is refused even with DispatchAgentRun, and linking a corpus record
// to a work item keeps the agent-run gate.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn() }));
jest.mock('../../lib/work-graph/live.js', () => ({ notifyWorkGraphChanged: jest.fn(async () => {}) }));
import express from 'express';
import request from '../../test-support/http.js';
import { workDocumentsRouter } from '../work-documents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { getWorkItem } from '../../providers/work-items.js';
import { getProject } from '../../providers/projects.js';
import { workspaceDocuments } from '../../providers/work-documents.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';

const PROJECT = 'p-auth-migration', WORK = 'wi-auth-e2-b3';
// The seed's split (middleware/seeds/roles/orgiq): every role that sees work holds ViewWorkItems; a member does not dispatch.
const HOLDS: Record<string, string[]> = {
  member: ['ViewWorkItems'], sme: ['ViewWorkItems', 'DispatchAgentRun'], 'org-leader': ['ViewWorkItems', 'DispatchAgentRun'], guest: [],
};
// sub -> [role, linked person]
const PEOPLE: Record<string, [string, string | null]> = {
  owner: ['member', 'per-owner'], contributor: ['member', 'per-contrib'], stranger: ['member', 'per-stranger'],
  'sme-stranger': ['sme', 'per-sme'], leader: ['org-leader', null], guest: ['guest', 'per-contrib'],
};
let app: express.Express;
const as = (sub: string) => ({ 'x-user': sub });
const list = (sub: string) => request(app).get(`/api/graph/projects/${PROJECT}/workspace-documents`).set(as(sub));
const create = (sub: string, body: Record<string, unknown>) => request(app).post(`/api/graph/projects/${PROJECT}/workspace-documents`).set(as(sub)).send(body);
const edit = (sub: string, id: string, body: Record<string, unknown>) => request(app).put(`/api/graph/documents/${id}`).set(as(sub)).send(body);

beforeEach(() => {
  jest.clearAllMocks(); workspaceDocuments.reset('default');
  jest.mocked(getUser).mockImplementation(async (id) => {
    const p = PEOPLE[id];
    return p ? { id, epoch: 0, grants: { orgiq: [p[0]] }, displayName: id, email: null, personId: p[1] } as UserInfo : null;
  });
  jest.mocked(isAllowed).mockImplementation(async (principal, action) => (HOLDS[principal.role] ?? []).includes(action));
  jest.mocked(getProject).mockImplementation(async (id) => (id === PROJECT
    ? { id, name: 'Auth Migration', ownerId: 'per-owner', contributors: [{ personId: 'per-contrib', role: 'contributor' }] } as unknown as Awaited<ReturnType<typeof getProject>>
    : null));
  jest.mocked(getWorkItem).mockImplementation(async (id) => (id === WORK ? { id, projectId: PROJECT } as Awaited<ReturnType<typeof getWorkItem>> : null));
  app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const sub = String(req.headers['x-user']); const p = PEOPLE[sub];
    if (p) req.session = { sub, tenant: 'orgiq', role: p[0], epoch: 0, iat: 1, grants: { orgiq: [p[0]] } } as Session;
    next();
  });
  app.use('/api/graph', workDocumentsRouter); app.use(errorHandler);
});

it('a contributor without DispatchAgentRun creates a page and a whiteboard, writes them, and the list says they may', async () => {
  expect((await list('contributor')).body.canWrite).toBe(true);
  const page = await create('contributor', { title: 'Cutover notes' });
  expect(page.status).toBe(201);
  expect(page.body.document).toMatchObject({ kind: 'page', title: 'Cutover notes', createdBy: 'contributor' });
  const board = await create('contributor', { title: 'Flow', kind: 'whiteboard' });
  expect(board.status).toBe(201);
  expect(board.body.document).toMatchObject({ kind: 'whiteboard', title: 'Flow' });
  expect((await edit('contributor', page.body.document.id, { markdown: '# Plan' })).status).toBe(200);
  expect((await edit('contributor', board.body.document.id, { scene: 'AQID' })).status).toBe(200);
  // The editor page reads the same answer to show its controls.
  expect((await request(app).get(`/api/graph/documents/${page.body.document.id}`).set(as('contributor'))).body.canWrite).toBe(true);
  // The owner (a member too) and an org-wide role write as well.
  expect((await create('owner', { title: 'Owner page' })).status).toBe(201);
  expect((await create('leader', { title: 'Leader page' })).status).toBe(201);
});

it('a stranger is refused, with or without DispatchAgentRun, and nothing is written', async () => {
  for (const sub of ['stranger', 'sme-stranger']) {
    const res = await create(sub, { title: 'Nope', kind: 'whiteboard' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ON_INITIATIVE');
    expect((await list(sub)).body.canWrite).toBe(false);
  }
  expect(workspaceDocuments.rows()).toEqual([]);
  const mine = (await create('contributor', { title: 'Mine' })).body.document;
  expect((await edit('stranger', mine.id, { title: 'Taken' })).status).toBe(403);
  expect((await request(app).get(`/api/graph/documents/${mine.id}`).set(as('stranger'))).body).toMatchObject({ title: 'Mine', canWrite: false });
});

it('a role without ViewWorkItems is refused before the initiative is asked', async () => {
  const res = await create('guest', { title: 'Nope' });
  expect(res.status).toBe(403);
  expect(res.body.code).toBeUndefined();
  expect((await list('guest')).body.canWrite).toBe(false);
});

it('linking a corpus record to a work item still needs DispatchAgentRun', async () => {
  expect((await request(app).put(`/api/graph/work-items/${WORK}/documents/doc-1`).set(as('contributor')).send()).status).toBe(403);
});

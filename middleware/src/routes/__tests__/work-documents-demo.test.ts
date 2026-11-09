// The cookie-less demo identity has no person link; under the dev flag it is an
// org-wide steward, so it may create a page (the demo stays explorable).
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../../providers/work-items.js', () => ({ getWorkItem: jest.fn() }));
jest.mock('../../providers/projects.js', () => ({ getProject: jest.fn(async (id: string) => ({ id, name: 'Auth Migration' })) }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../../lib/work-graph/live.js', () => ({ notifyWorkGraphChanged: jest.fn(async () => {}) }));
import express from 'express';
import request from '../../test-support/http.js';
import { workDocumentsRouter } from '../work-documents.js';
import { errorHandler } from '../../lib/async-handler.js';
import { workspaceDocuments } from '../../providers/work-documents.js';
import type { Session } from '../../lib/session.js';

const PROJECT = 'p-auth-migration';
const demo: Session = { sub: 'demo-user', tenant: 'orgiq', role: 'sme', epoch: 0, iat: 1, grants: { orgiq: ['sme'] } };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as unknown as { session: Session }).session = demo; next(); });
app.use('/api/graph', workDocumentsRouter);
app.use(errorHandler);

beforeEach(() => workspaceDocuments.reset('default'));

it('the demo identity under the dev flag may create a page and is told canWrite', async () => {
  const res = await request(app).post(`/api/graph/projects/${PROJECT}/workspace-documents`).send({ title: 'Demo page' });
  expect(res.status).toBeLessThan(300);
  const list = await request(app).get(`/api/graph/projects/${PROJECT}/workspace-documents`);
  expect(list.body.canWrite).toBe(true);
});

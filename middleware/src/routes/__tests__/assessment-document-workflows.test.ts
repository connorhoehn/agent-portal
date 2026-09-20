jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));
jest.mock('../../providers/document-workflows.js', () => ({ ...jest.requireActual('../../providers/document-workflows.js'), performDocumentWorkflow: jest.fn() }));
jest.mock('../../providers/assessment.js', () => ({}));
jest.mock('../../providers/document-canvas.js', () => ({}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [{ id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] }] }));
import express from 'express';
import request from '../../test-support/http.js';
import { assessmentDocumentWorkflowsRouter } from '../assessment-document-workflows.js';
import { performDocumentWorkflow } from '../../providers/document-workflows.js';
import type { Session } from '../../lib/session.js';
const session: Session = { sub: 'alice', role: 'assessor', tenant: 'assessment', iat: 0, grants: { assessment: ['assessor'] } };
function app(identity: Session = session) { return express().use(express.json()).use((req, _res, next) => { req.session = identity; next(); }).use('/api/assessment/knowledge', assessmentDocumentWorkflowsRouter); }
const url = '/api/assessment/knowledge/doc/workflows';
beforeEach(() => { jest.clearAllMocks(); jest.mocked(performDocumentWorkflow).mockResolvedValue({ status: 200, body: { lifecycle: { status: 'draft' }, availableActions: [] } }); });
it('returns platform actions with no-store caching', async () => {
  const result = await request(app()).get(`${url}?id=page%3A100002`); expect(result.status).toBe(200); expect(result.headers['cache-control']).toBe('no-store');
  expect(performDocumentWorkflow).toHaveBeenCalledWith('page:100002', session, { kind: 'lifecycle', method: 'GET' });
});
it('denies cross-tenant sessions before resolving documents', async () => {
  expect((await request(app({ ...session, tenant: 'orgiq', role: 'member' })).get(`${url}?id=page:100002`)).status).toBe(403); expect(performDocumentWorkflow).not.toHaveBeenCalled();
});
it.each([{ action: 'approve', sub: 'owner' }, { action: 'approve', documentId: 'other' }, { action: 'approve', token: 'admin' }, { action: 'approve', path: '/users' }])('rejects browser authority fields', async body => {
  expect((await request(app()).post(`${url}/transitions?id=page:100002`).send(body)).status).toBe(400); expect(performDocumentWorkflow).not.toHaveBeenCalled();
});
it('preserves transition conflicts', async () => {
  jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 409, body: { error: 'changed', code: 'concurrent_modification' } });
  const result = await request(app()).post(`${url}/transitions?id=page:100002`).send({ action: 'submit', reason: 'Ready' }); expect(result.status).toBe(409); expect(result.body.code).toBe('concurrent_modification');
});
it('delegates assigned reviewer verdicts', async () => {
  await request(app()).patch(`${url}/review-requests/document%23alice?id=page:100002`).send({ state: 'approved', comment: 'Reviewed' });
  expect(performDocumentWorkflow).toHaveBeenCalledWith('page:100002', session, { kind: 'update-review', method: 'PATCH', requestKey: 'document#alice', body: { state: 'approved', comment: 'Reviewed' } });
});
it('has no arbitrary platform path route', async () => { expect((await request(app()).get(`${url}/users?id=page:100002`)).status).toBe(404); expect(performDocumentWorkflow).not.toHaveBeenCalled(); });

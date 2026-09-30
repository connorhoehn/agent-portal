jest.mock('../../providers/document-versions.js', () => ({ changeDocumentVersion: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));
jest.mock('../../providers/document-workflows.js', () => ({ ...jest.requireActual('../../providers/document-workflows.js'), performDocumentWorkflow: jest.fn() }));
jest.mock('../../providers/assessment.js', () => {
  // Only what the comment routes read: the source and its legacy thread (the dev:mock fixture).
  const fixtures = jest.requireActual('../../mock/assessment.js');
  return {
    getKnowledgeDoc: jest.fn(async (id: string) => id === 'page:100002' ? { id, title: 'Rubric Overview', classification: 'synced', markdown: '# Rubric', path: '', editable: false, updated_at: '' } : null),
    listKnowledgeComments: jest.fn(async (id: string) => fixtures.knowledgeComments(id)),
  };
});
jest.mock('../../providers/identity.js', () => {
  const users: Record<string, { id: string; displayName: string; grants: Record<string, string[]> }> = {
    'u-jonas': { id: 'u-jonas', displayName: 'Jonas Lindqvist', grants: { assessment: ['assessor'] } },
    'u-farah': { id: 'u-farah', displayName: 'Farah Osei', grants: { assessment: ['lead-assessor'] } },
    'u-hr': { id: 'u-hr', displayName: 'Priya Desai', grants: { orgiq: ['hr-admin'] } },
  };
  return { listUsers: jest.fn(async () => []), getUser: jest.fn(async (id: string) => users[id] ?? null) };
});
jest.mock('../../lib/assessment-broker.js', () => ({ assessmentBroker: { publish: jest.fn() } }));
jest.mock('../../providers/document-canvas.js', () => ({}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [{ id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] }] }));
import express from 'express';
import request from '../../test-support/http.js';
import { assessmentDocumentWorkflowsRouter } from '../assessment-document-workflows.js';
import { changeDocumentVersion } from '../../providers/document-versions.js';
import { performDocumentWorkflow } from '../../providers/document-workflows.js';
import type { Session } from '../../lib/session.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
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

it('rejects fabricated restore actor and invalid timestamps', async () => {
  expect((await request(app()).post(`${url}/versions/restore?id=page:1`).send({ timestamp: 123, actor: 'owner' })).status).toBe(400);
  expect((await request(app()).post(`${url}/versions/restore?id=page:1`).send({ timestamp: '../other' })).status).toBe(400);
  expect(changeDocumentVersion).not.toHaveBeenCalled();
});
it('returns only the server acknowledged saved version', async () => {
  jest.mocked(changeDocumentVersion).mockResolvedValueOnce({ timestamp: 123, name: 'Saved' });
  const result = await request(app()).post(`${url}/versions?id=page:1`).send({ name: 'Saved' });
  expect(result.status).toBe(200); expect(result.body).toEqual({ timestamp: 123, name: 'Saved' });
  expect(changeDocumentVersion).toHaveBeenCalledWith('page:1', session, { action: 'save', name: 'Saved' });
});

describe('document comments', () => {
  it('lists through the BFF with no-store and never takes a document id from the browser', async () => {
    const list = await request(app()).get(`${url}/comments?id=page%3A100002`);
    expect(list.status).toBe(200); expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body.comments.map((c: { commentId: string }) => c.commentId)).toEqual(['kc-rubric-01', 'kc-rubric-02']);
    expect(list.body.import).toMatchObject({ state: 'imported', imported: 2 });
    expect((await request(app()).get(`${url}/comments`)).status).toBe(400);
  });
  it('rejects browser-supplied authority fields on a comment', async () => {
    expect((await request(app()).post(`${url}/comments?id=page%3A100002`).send({ text: 'x', scope: 'document', userId: 'u-jonas' })).status).toBe(400);
    expect((await request(app()).post(`${url}/comments?id=page%3A100002`).send({ text: 'x', scope: 'document', documentId: 'other' })).status).toBe(400);
  });
  it('creates, resolves and deletes; delete answers 204 with no body', async () => {
    const created = await request(app()).post(`${url}/comments?id=page%3A100002`).send({ text: 'Route check', scope: 'document' });
    expect(created.status).toBe(201); expect(created.body.comment).toMatchObject({ userId: 'alice', scope: 'document' });
    const id = created.body.comment.commentId as string;
    expect((await request(app()).patch(`${url}/comments/${id}?id=page%3A100002`).send({ resolved: true })).body.comment).toMatchObject({ resolved: true });
    const removed = await request(app()).delete(`${url}/comments/${id}?id=page%3A100002`);
    expect(removed.status).toBe(204); expect(removed.text).toBe('');
  });
  it('denies cross-tenant sessions', async () => {
    expect((await request(app({ ...session, tenant: 'orgiq', role: 'member' })).get(`${url}/comments?id=page%3A100002`)).status).toBe(403);
  });
  it('a reply notifies the parent comment\'s author through the activity seam (design §3.4 row 1)', async () => {
    const sent: Array<{ userId: string; input: NotificationInputLike }> = [];
    setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } });
    try {
      const farah: Session = { sub: 'u-farah', name: 'Farah Osei', role: 'assessor', tenant: 'assessment', iat: 0, grants: { assessment: ['assessor'] } };
      const reply = await request(app(farah)).post('/api/assessment/knowledge/doc/workflows/comments?id=page%3A100002').send({ text: 'Adding it now', parentCommentId: 'kc-rubric-01' });
      expect(reply.status).toBe(201);
      for (let i = 0; i < 50 && !sent.length; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(sent.map((s) => s.userId)).toEqual(['u-jonas']);
      expect(sent[0]!.input).toMatchObject({
        type: 'reply', title: 'Farah Osei replied to your comment', body: expect.stringContaining('Rubric Overview'),
        payload: { tenant: 'assessment', category: 'Assessment', documentId: 'page:100002' },
        action: { href: '/assessment/workspace?doc=page%3A100002&tab=comments' },
      });
    } finally { setNotificationSink(null); }
  });
});

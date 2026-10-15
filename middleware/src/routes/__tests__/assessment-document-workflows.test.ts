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
    'u-hr': { id: 'u-hr', displayName: 'Helen Desai', grants: { orgiq: ['hr-admin'] } },
  };
  return { listUsers: jest.fn(async () => []), getUser: jest.fn(async (id: string) => users[id] ?? null) };
});
jest.mock('../../lib/assessment-broker.js', () => ({ assessmentBroker: { publish: jest.fn() } }));
jest.mock('../../providers/document-canvas.js', () => ({ documentWorkflowAccess: jest.fn() }));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [{ id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] }] }));
import express from 'express';
import request from '../../test-support/http.js';
import { assessmentDocumentWorkflowsRouter } from '../assessment-document-workflows.js';
import { changeDocumentVersion } from '../../providers/document-versions.js';
import { performDocumentWorkflow } from '../../providers/document-workflows.js';
import type { Session } from '../../lib/session.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { listUsers } from '../../providers/identity.js';
import { documentWorkflowAccess } from '../../providers/document-canvas.js';
const session: Session = { sub: 'alice', role: 'assessor', tenant: 'assessment', iat: 0, grants: { assessment: ['assessor'] } };
function app(identity: Session | null = session) { return express().use(express.json()).use((req, _res, next) => { if (identity) req.session = identity; next(); }).use('/api/assessment/knowledge', assessmentDocumentWorkflowsRouter); }
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
    expect(list.body.comments.map((c: { commentId: string }) => c.commentId)).toEqual(['kc-rubric-01', 'kc-rubric-02', 'kc-rubric-03']);
    expect(list.body.import).toMatchObject({ state: 'imported', imported: 3 });
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

describe('review and checklist routes delegate one fixed operation each', () => {
  it('a caller with no assessment session is refused by the tenant guard, with no platform call', async () => {
    expect((await request(app(null)).get(`${url}/review-requests?id=page:100002`)).status).toBe(403);
    expect(performDocumentWorkflow).not.toHaveBeenCalled();
  });
  it('GET review-requests and reviews pass the platform body and status through, no-store', async () => {
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { requests: [{ requestKey: 'document#u-jonas', state: 'pending' }] } });
    const pending = await request(app()).get(`${url}/review-requests?id=page%3A100002`);
    expect(pending.status).toBe(200); expect(pending.headers['cache-control']).toBe('no-store');
    expect(pending.body.requests).toEqual([{ requestKey: 'document#u-jonas', state: 'pending' }]);
    expect(performDocumentWorkflow).toHaveBeenLastCalledWith('page:100002', session, { kind: 'review-requests', method: 'GET' });
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 404, body: { error: 'no reviews' } });
    const reviews = await request(app()).get(`${url}/reviews?id=page%3A100002`);
    expect(reviews.status).toBe(404); expect(reviews.body).toEqual({ error: 'no reviews' });
    expect(performDocumentWorkflow).toHaveBeenLastCalledWith('page:100002', session, { kind: 'reviews', method: 'GET' });
  });
  it('a request without a document id is 400 before delegation', async () => {
    expect((await request(app()).get(`${url}/reviews`)).status).toBe(400);
    expect((await request(app()).get(`${url}/review-requests?id=${'x'.repeat(1025)}`)).status).toBe(400);
    expect(performDocumentWorkflow).not.toHaveBeenCalled();
  });
  it('POST review-requests forwards only the whitelisted assignment fields', async () => {
    const assignment = { reviewerId: 'u-jonas', sectionId: 's1', dueDate: '2026-10-08', note: 'Please check', required: true };
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 201, body: { requestKey: 'document#u-jonas' } });
    const created = await request(app()).post(`${url}/review-requests?id=page:100002`).send(assignment);
    expect(created.status).toBe(201); expect(created.body).toEqual({ requestKey: 'document#u-jonas' });
    expect(performDocumentWorkflow).toHaveBeenCalledWith('page:100002', session, { kind: 'request-review', method: 'POST', body: assignment });
    expect((await request(app()).post(`${url}/review-requests?id=page:100002`).send({ reviewerId: 'u-jonas', requestedBy: 'owner' })).status).toBe(400);
    expect(performDocumentWorkflow).toHaveBeenCalledTimes(1);
  });
  it('POST ownership takes an empty body only, and surfaces the platform conflict', async () => {
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 409, body: { error: 'already owned' } });
    const claimed = await request(app()).post(`${url}/ownership?id=page:100002`).send({});
    expect(claimed.status).toBe(409); expect(claimed.body.error).toBe('already owned');
    expect(performDocumentWorkflow).toHaveBeenCalledWith('page:100002', session, { kind: 'ownership', method: 'POST', body: {} });
    expect((await request(app()).post(`${url}/ownership?id=page:100002`).send({ ownerId: 'alice' })).status).toBe(400);
    expect(performDocumentWorkflow).toHaveBeenCalledTimes(1);
  });
  it('GET section items names the section from the path', async () => {
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { items: [{ itemId: 'i1', acknowledged: false }] } });
    const items = await request(app()).get(`${url}/sections/rubric%20one/items?id=page:100002`);
    expect(items.status).toBe(200); expect(items.body.items).toHaveLength(1);
    expect(performDocumentWorkflow).toHaveBeenCalledWith('page:100002', session, { kind: 'items', method: 'GET', sectionId: 'rubric one' });
  });
  it('POST item ack takes no body fields; answer takes only `answer`', async () => {
    const ack = await request(app()).post(`${url}/sections/s1/items/i1/ack?id=page:100002`).send({});
    expect(ack.status).toBe(200);
    expect(performDocumentWorkflow).toHaveBeenLastCalledWith('page:100002', session, { kind: 'item-ack', method: 'POST', sectionId: 's1', itemId: 'i1', body: {} });
    expect((await request(app()).post(`${url}/sections/s1/items/i1/ack?id=page:100002`).send({ by: 'owner' })).status).toBe(400);
    const answer = await request(app()).post(`${url}/sections/s1/items/i2/answer?id=page:100002`).send({ answer: 'Yes, evidence attached' });
    expect(answer.status).toBe(200);
    expect(performDocumentWorkflow).toHaveBeenLastCalledWith('page:100002', session, { kind: 'item-answer', method: 'POST', sectionId: 's1', itemId: 'i2', body: { answer: 'Yes, evidence attached' } });
    expect((await request(app()).post(`${url}/sections/s1/items/i2/answer?id=page:100002`).send({ answer: 'x', userId: 'owner' })).status).toBe(400);
    expect(performDocumentWorkflow).toHaveBeenCalledTimes(2);
  });
  it('an unexpected provider failure is 503, never a leaked error', async () => {
    jest.mocked(performDocumentWorkflow).mockRejectedValueOnce(new Error('socket hang up'));
    const res = await request(app()).get(`${url}/reviews?id=page:100002`);
    expect(res.status).toBe(503); expect(res.body.error).toMatch(/unavailable/); expect(JSON.stringify(res.body)).not.toContain('socket');
  });
  it('denies cross-tenant sessions on every review route', async () => {
    const orgiq: Session = { ...session, tenant: 'orgiq', role: 'member' };
    expect((await request(app(orgiq)).post(`${url}/review-requests?id=page:100002`).send({ reviewerId: 'u-jonas' })).status).toBe(403);
    expect((await request(app(orgiq)).post(`${url}/sections/s1/items/i1/answer?id=page:100002`).send({ answer: 'x' })).status).toBe(403);
    expect(performDocumentWorkflow).not.toHaveBeenCalled();
  });
});

describe('GET reviewers — the eligible-reviewer directory', () => {
  const uuid = '11111111-2222-3333-4444-555555555555';
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    process.env['DOCUMENT_PLATFORM_INTERNAL_URL'] = 'http://platform.test/';
    jest.mocked(documentWorkflowAccess).mockResolvedValue({ documentId: uuid, token: 't', canManageWorkflow: true } as never);
    jest.mocked(listUsers).mockResolvedValue([
      { id: 'u-jonas', displayName: 'Jonas Lindqvist', grants: { assessment: ['assessor'] } },
      { id: 'u-hr', displayName: 'Helen Desai', grants: { orgiq: ['hr-admin'] } },
    ] as never);
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => { delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL']; fetchSpy.mockRestore(); });
  const lifecycle = (ownerId: string | null) => fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ lifecycle: { ownerId, status: 'draft' } }), { status: 200 }));
  it('the document owner sees only users who currently hold assessment access', async () => {
    lifecycle('alice');
    const res = await request(app()).get(`${url}/reviewers?id=page%3A100002`);
    expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ reviewers: [{ id: 'u-jonas', displayName: 'Jonas Lindqvist' }] });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(`http://platform.test/api/documents/${uuid}/lifecycle`);
  });
  it('a non-owner is refused the directory', async () => {
    lifecycle('someone-else');
    const res = await request(app()).get(`${url}/reviewers?id=page%3A100002`);
    expect(res.status).toBe(403); expect(listUsers).not.toHaveBeenCalled();
  });
  it('an unconfigured platform answers 503, not an empty directory', async () => {
    delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
    const res = await request(app()).get(`${url}/reviewers?id=page%3A100002`);
    expect(res.status).toBe(503); expect(res.body.reviewers).toBeUndefined();
  });
});

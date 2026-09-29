jest.mock('../identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
jest.mock('../document-canvas.js', () => ({ documentWorkflowAccess: jest.fn() }));
import { getUser, listUsers } from '../identity.js';
import { performDocumentWorkflow, listDocumentReviewers } from '../document-workflows.js';
import { getKnowledgeDoc } from '../assessment.js';
import { documentWorkflowAccess } from '../document-canvas.js';
import type { Session } from '../../lib/session.js';
const session: Session = { sub: 'alice', role: 'assessor', tenant: 'assessment', iat: 0, grants: { assessment: ['assessor'] } };
const documentId = '00000000-0000-4000-a000-000000000001';
const originalFetch = global.fetch;
const originalUrl = process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
const source = { id: 'page:100002', title: 'Rubric', classification: 'synced' as const, markdown: '# Rubric', path: 'confluence/100002', editable: false, updated_at: '' };
beforeEach(() => {
  jest.clearAllMocks(); process.env['DOCUMENT_PLATFORM_INTERNAL_URL'] = 'http://platform:3001';
  jest.mocked(getKnowledgeDoc).mockResolvedValue(source);
  jest.mocked(documentWorkflowAccess).mockResolvedValue({ documentId, sourceId: source.id, token: 'scoped-token', title: source.title, classification: source.classification, canEdit: false, canManageWorkflow: false, gatewayUrl: 'ws://gateway', expiresAt: 1, sourceRevision: 'revision' });
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ lifecycle: { status: 'draft' }, availableActions: [] }), { status: 200 }));
});
afterAll(() => { global.fetch = originalFetch; if (originalUrl === undefined) delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL']; else process.env['DOCUMENT_PLATFORM_INTERNAL_URL'] = originalUrl; });
it('uses the canonical mapping and verified session grant without exposing the grant', async () => {
  const result = await performDocumentWorkflow(source.id, session, { kind: 'lifecycle', method: 'GET' });
  expect(documentWorkflowAccess).toHaveBeenCalledWith(source, session);
  expect(fetch).toHaveBeenCalledWith(new URL(`http://platform:3001/api/documents/${documentId}/lifecycle`), expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer scoped-token' }) }));
  expect(result.body).toEqual({ documentId, lifecycle: { status: 'draft' }, availableActions: [], canManageWorkflow: false, canClaimOwnership: false }); expect(JSON.stringify(result)).not.toContain('scoped-token');
});
it.each([403, 409, 503])('preserves platform authorization/CAS failure %s without retries', async status => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ error: 'Refused', code: 'owner_not_established' }), { status }));
  expect(await performDocumentWorkflow(source.id, session, { kind: 'transition', method: 'POST', body: { action: 'publish' } })).toEqual({ status, body: { error: 'Refused', code: 'owner_not_established' } }); expect(fetch).toHaveBeenCalledTimes(1);
});
it('refuses a missing source before delegating identity', async () => {
  jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null);
  await expect(performDocumentWorkflow('missing', session, { kind: 'lifecycle', method: 'GET' })).rejects.toMatchObject({ status: 404 }); expect(documentWorkflowAccess).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('does not contact platform when session verification fails', async () => {
  jest.mocked(documentWorkflowAccess).mockRejectedValueOnce(new Error('revoked'));
  await expect(performDocumentWorkflow(source.id, session, { kind: 'lifecycle', method: 'GET' })).rejects.toThrow('revoked'); expect(fetch).not.toHaveBeenCalled();
});
it.each(['..', '../other', 'one/two', 'one\\two'])('rejects resource traversal %s', async sectionId => {
  await expect(performDocumentWorkflow(source.id, session, { kind: 'items', method: 'GET', sectionId })).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
});
it('encodes a review key under this document', async () => {
  await performDocumentWorkflow(source.id, session, { kind: 'update-review', method: 'PATCH', requestKey: 'document#reviewer', body: { state: 'approved' } });
  expect(String(jest.mocked(fetch).mock.calls[0]![0])).toBe(`http://platform:3001/api/documents/${documentId}/review-requests/document%23reviewer`);
});

it('validates a reviewer against authoritative current assessment identity', async () => {
  jest.mocked(documentWorkflowAccess).mockResolvedValueOnce({ documentId, sourceId: source.id, token: 'scoped-token', title: source.title, classification: source.classification, canEdit: true, canManageWorkflow: true, gatewayUrl: 'ws://gateway', expiresAt: 1, sourceRevision: 'revision' });
  jest.mocked(getUser).mockResolvedValueOnce({ id: 'outside', displayName: 'Outside', email: null, personId: null, epoch: 0, grants: { orgiq: ['member'] } });
  await expect(performDocumentWorkflow(source.id, session, { kind: 'request-review', method: 'POST', body: { reviewerId: 'outside' } })).rejects.toMatchObject({ status: 400 });
  expect(getUser).toHaveBeenCalledWith('outside', { authoritative: true }); expect(fetch).not.toHaveBeenCalled();
});
it('offers only actual eligible assessment identities to the explicit document manager', async () => {
  jest.mocked(documentWorkflowAccess).mockResolvedValueOnce({ documentId, sourceId: source.id, token: 'scoped-token', title: source.title, classification: source.classification, canEdit: true, canManageWorkflow: true, gatewayUrl: 'ws://gateway', expiresAt: 1, sourceRevision: 'revision' });
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ lifecycle: { status: 'draft', ownerId: session.sub }, availableActions: [] })));
  jest.mocked(listUsers).mockResolvedValueOnce([
    { id: 'reviewer', displayName: 'Known reviewer', email: null, personId: null, epoch: 0, grants: { assessment: ['assessor'] } },
    { id: 'outside', displayName: 'Outside', email: null, personId: null, epoch: 0, grants: { orgiq: ['member'] } },
  ]);
  expect(await listDocumentReviewers(source.id, session)).toEqual({ reviewers: [{ id: 'reviewer', displayName: 'Known reviewer' }] });
});
it('does not expose the assignment directory to a document reader', async () => {
  await expect(listDocumentReviewers(source.id, session)).rejects.toMatchObject({ status: 403 }); expect(listUsers).not.toHaveBeenCalled();
});

it('reaches document comments as fixed operations under this document only', async () => {
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ comments: [] }), { status: 200 }));
  await performDocumentWorkflow(source.id, session, { kind: 'comments', method: 'GET', cursor: 'abc=' });
  expect(String(jest.mocked(fetch).mock.calls[0]![0])).toBe(`http://platform:3001/api/documents/${documentId}/comments?limit=200&cursor=abc%3D`);
  await performDocumentWorkflow(source.id, session, { kind: 'comment-update', method: 'PATCH', commentId: '01J#x', body: { resolved: true } });
  expect(String(jest.mocked(fetch).mock.calls[1]![0])).toBe(`http://platform:3001/api/documents/${documentId}/comments/01J%23x`);
  global.fetch = jest.fn(async () => new Response(null, { status: 204 }));
  expect(await performDocumentWorkflow(source.id, session, { kind: 'comment-delete', method: 'DELETE', commentId: '01J' })).toEqual({ status: 204, body: { documentId } });
  await expect(performDocumentWorkflow(source.id, session, { kind: 'comment-delete', method: 'DELETE', commentId: '../lifecycle' })).rejects.toMatchObject({ status: 400 });
});

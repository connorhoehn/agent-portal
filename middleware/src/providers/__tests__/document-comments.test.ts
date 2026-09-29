// Assessment document comments on platform-api threads
// (providers/document-comments.ts): the platform path goes through the BFF's
// document grant, the dev:mock path mirrors platform-api's rules.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/assessment-broker.js', () => ({ assessmentBroker: { publish: jest.fn() } }));
jest.mock('../identity.js', () => ({ listUsers: jest.fn(async () => [
  { id: 'u-jonas', displayName: 'Jonas Lindqvist' }, { id: 'u-farah', displayName: 'Farah Osei' },
]) }));
jest.mock('../document-workflows.js', () => ({ ...jest.requireActual('../document-workflows.js'), performDocumentWorkflow: jest.fn() }));
import { fixtureRegistry } from '../../mock/core/fixture.js';
import { assessmentBroker } from '../../lib/assessment-broker.js';
import { performDocumentWorkflow } from '../document-workflows.js';
import {
  createDocumentComment, deleteDocumentComment, documentCommentTargetIds, listDocumentComments, updateDocumentComment,
} from '../document-comments.js';
import type { Session } from '../../lib/session.js';

const farah: Session = { sub: 'u-farah', role: 'lead-assessor', tenant: 'assessment', iat: 0, grants: { assessment: ['lead-assessor'] } };
const jonas: Session = { ...farah, sub: 'u-jonas', role: 'assessor' };
const env = { ...process.env };
const anchor = { v: 1, key: 'body', start: 'AAE=', end: 'AAI=', quote: 'Partially met' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
  delete process.env['DOCUMENT_COMMENT_IMPORT_TABLE'];
  for (const key of ['assessment-platform-document-comments', 'assessment-document-comment-imports', 'assessment-knowledge-comments', 'assessment-document-mappings']) {
    fixtureRegistry.get(key)?.reset();
  }
});
afterAll(() => { process.env = env; });

describe('dev:mock backend', () => {
  it('lists the imported legacy thread with names from the identity store, oldest first', async () => {
    const list = await listDocumentComments('page:100002', farah);
    expect(list.import).toMatchObject({ state: 'imported', imported: 2 });
    expect(list.comments.map(c => [c.commentId, c.displayName, c.scope ?? null, c.parentCommentId ?? null])).toEqual([
      ['kc-rubric-01', 'Jonas Lindqvist', 'document', null],
      ['kc-rubric-02', 'Farah Osei', null, 'kc-rubric-01'],
    ]);
    expect(list.documentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates document-wide, anchored and reply comments under platform-api’s exclusivity rules', async () => {
    const root = await createDocumentComment('page:100002', farah, { text: 'Whole page', scope: 'document' });
    expect(root.status).toBe(201);
    expect(root.body['comment']).toMatchObject({ text: 'Whole page', userId: 'u-farah', displayName: 'Farah Osei', scope: 'document' });
    const pinned = await createDocumentComment('page:100002', jonas, { text: 'This band', anchor });
    expect(pinned.body['comment']).toMatchObject({ anchor, userId: 'u-jonas' });
    const reply = await createDocumentComment('page:100002', jonas, { text: 'Yes', parentCommentId: 'kc-rubric-01' });
    expect(reply.body['comment']).toMatchObject({ parentCommentId: 'kc-rubric-01' });
    expect(assessmentBroker.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'knowledge.comment.created', doc_id: 'page:100002' }));

    await expect(createDocumentComment('page:100002', farah, { text: 'x', scope: 'document', anchor })).rejects.toMatchObject({ status: 400 });
    await expect(createDocumentComment('page:100002', farah, { text: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(createDocumentComment('page:100002', farah, { text: 'x', parentCommentId: 'nope' })).rejects.toMatchObject({ status: 404 });
    await expect(createDocumentComment('page:100002', farah, { text: 'x', scope: 'document', userId: 'u-jonas' })).rejects.toMatchObject({ status: 400 });
    await expect(createDocumentComment('page:100002', farah, { text: 'x', anchor: { ...anchor, v: 0 } })).rejects.toMatchObject({ status: 400 });
  });

  it('resolves for any reader, edits and deletes for the author only', async () => {
    const resolved = await updateDocumentComment('page:100002', farah, 'kc-rubric-01', { resolved: true });
    expect(resolved.body['comment']).toMatchObject({ commentId: 'kc-rubric-01', resolved: true, resolvedBy: 'u-farah' });
    expect((await listDocumentComments('page:100002', farah)).comments[0]).toMatchObject({ resolved: true });
    await updateDocumentComment('page:100002', farah, 'kc-rubric-01', { resolved: false });
    expect((await listDocumentComments('page:100002', farah)).comments[0]).not.toHaveProperty('resolved');

    await expect(updateDocumentComment('page:100002', farah, 'kc-rubric-01', { text: 'mine now' })).rejects.toMatchObject({ status: 403 });
    expect((await updateDocumentComment('page:100002', jonas, 'kc-rubric-01', { text: 'Edited' })).body['comment']).toMatchObject({ text: 'Edited', editedAt: expect.any(String) });
    await expect(deleteDocumentComment('page:100002', farah, 'kc-rubric-01')).rejects.toMatchObject({ status: 403 });
    expect(await deleteDocumentComment('page:100002', jonas, 'kc-rubric-01')).toEqual({ status: 204, body: {} });
    await expect(updateDocumentComment('page:100002', jonas, '../x', { resolved: true })).rejects.toMatchObject({ status: 400 });
  });

  it('offers every comment id on the document as a reaction target', async () => {
    await createDocumentComment('page:100002', farah, { text: 'New', scope: 'document' });
    const targets = await documentCommentTargetIds('page:100002', farah);
    expect(targets).toEqual(expect.arrayContaining(['kc-rubric-01', 'kc-rubric-02']));
    expect(targets).toHaveLength(3);
  });

  it('refuses an unknown document', async () => {
    await expect(listDocumentComments('page:nope', farah)).rejects.toMatchObject({ status: 404 });
  });
});

describe('platform-api backend', () => {
  beforeEach(() => { process.env['DOCUMENT_PLATFORM_INTERNAL_URL'] = 'http://platform:3001'; });

  it('pages through platform-api with the grant and names the grant subjects', async () => {
    jest.mocked(performDocumentWorkflow)
      .mockResolvedValueOnce({ status: 200, body: { comments: [{ documentId: 'd', commentId: '01B', text: 'b', userId: 'u-farah', displayName: 'u-farah', color: '#4A90D9', timestamp: '2026-09-29T10:00:01Z', scope: 'document' }], nextCursor: 'next' } })
      .mockResolvedValueOnce({ status: 200, body: { comments: [{ documentId: 'd', commentId: '01A', text: 'a', userId: 'u-jonas', displayName: 'u-jonas', color: '#4A90D9', timestamp: '2026-09-29T10:00:00Z', anchor }] } });
    const list = await listDocumentComments('page:100002', farah);
    expect(performDocumentWorkflow).toHaveBeenNthCalledWith(1, 'page:100002', farah, { kind: 'comments', method: 'GET' });
    expect(performDocumentWorkflow).toHaveBeenNthCalledWith(2, 'page:100002', farah, { kind: 'comments', method: 'GET', cursor: 'next' });
    expect(list.comments.map(c => [c.commentId, c.displayName])).toEqual([['01A', 'Jonas Lindqvist'], ['01B', 'Farah Osei']]);
    // No import table configured: the legacy thread is reported, not silently dropped.
    expect(list.import).toMatchObject({ state: 'unconfigured', legacy: 2 });
  });

  it('delegates writes as fixed comment operations and keeps platform refusals intact', async () => {
    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 201, body: { comment: { documentId: 'd', commentId: '01C', text: 'hi', userId: 'u-farah', displayName: 'u-farah', color: '#4A90D9', timestamp: 't', scope: 'document' } } });
    const created = await createDocumentComment('page:100002', farah, { text: 'hi', scope: 'document' });
    expect(performDocumentWorkflow).toHaveBeenCalledWith('page:100002', farah, { kind: 'comment-create', method: 'POST', body: { text: 'hi', scope: 'document' } });
    expect(created.body['comment']).toMatchObject({ displayName: 'Farah Osei' });

    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 403, body: { error: 'Only the author may edit comment text' } });
    expect(await updateDocumentComment('page:100002', farah, '01A', { text: 'x' })).toEqual({ status: 403, body: { error: 'Only the author may edit comment text' } });
    expect(performDocumentWorkflow).toHaveBeenLastCalledWith('page:100002', farah, { kind: 'comment-update', method: 'PATCH', commentId: '01A', body: { text: 'x' } });

    jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 204, body: { documentId: 'd' } });
    expect((await deleteDocumentComment('page:100002', farah, '01A')).status).toBe(204);
    expect(performDocumentWorkflow).toHaveBeenLastCalledWith('page:100002', farah, { kind: 'comment-delete', method: 'DELETE', commentId: '01A' });
  });
});

it('answers 503 with neither a platform nor the mock', async () => {
  const { config } = await import('../../config.js');
  Object.assign(config.mock, { aurora: false });
  await expect(listDocumentComments('page:100002', farah)).rejects.toMatchObject({ status: 503 });
  Object.assign(config.mock, { aurora: true });
});

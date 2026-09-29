// The one-time import of the legacy assessment comment thread into
// platform-api's document comments (providers/document-comment-import.ts).
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../identity.js', () => ({ listUsers: jest.fn(async () => [
  { id: 'u-jonas', displayName: 'Jonas Lindqvist' }, { id: 'u-farah', displayName: 'Farah Osei' },
]) }));
import { config } from '../../config.js';
import { exec } from '../aurora.js';
import { fixtureRegistry } from '../../mock/core/fixture.js';
import { platformDocumentCommentsFixture } from '../../mock/document-comments.js';
import { ensureLegacyCommentsImported, isoTimestamp, legacyThreadMoved, planLegacyCommentImport } from '../document-comment-import.js';
import type { KnowledgeComment } from '../../mock/assessment.js';

const documentId = '00000000-0000-4000-a000-000000000002';
const names = new Map([['u-jonas', 'Jonas Lindqvist'], ['u-farah', 'Farah Osei']]);
const env = { ...process.env };

beforeEach(() => {
  Object.assign(config.mock, { aurora: true });
  delete process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
  delete process.env['DOCUMENT_COMMENT_IMPORT_TABLE'];
  for (const key of ['assessment-platform-document-comments', 'assessment-document-comment-imports', 'assessment-knowledge-comments', 'assessment-document-mappings']) {
    fixtureRegistry.get(key)?.reset();
  }
});
afterAll(() => { process.env = env; });

describe('planLegacyCommentImport', () => {
  it('keeps ids, authors, timestamps and the reply edge; roots become document-wide threads', () => {
    const legacy: KnowledgeComment[] = [
      { id: 'kc-1', doc_id: 'page:1', parent_id: null, body: 'Root', author: 'u-jonas', created_at: '2026-09-20 10:00:00.5+00' },
      { id: 'kc-2', doc_id: 'page:1', parent_id: 'kc-1', body: 'Reply', author: 'u-farah', created_at: '2026-09-21T11:00:00Z', edited_at: '2026-09-22 09:00:00+00' },
    ];
    expect(planLegacyCommentImport(documentId, legacy, names)).toEqual([
      { documentId, commentId: 'kc-1', text: 'Root', userId: 'u-jonas', displayName: 'Jonas Lindqvist', color: '#4A90D9',
        timestamp: '2026-09-20T10:00:00.500Z', scope: 'document', importedFrom: 'assessment_knowledge_comments' },
      { documentId, commentId: 'kc-2', text: 'Reply', userId: 'u-farah', displayName: 'Farah Osei', color: '#4A90D9',
        timestamp: '2026-09-21T11:00:00.000Z', parentCommentId: 'kc-1', editedAt: '2026-09-22T09:00:00.000Z', importedFrom: 'assessment_knowledge_comments' },
    ]);
  });

  it('carries a removed comment only while live replies hang off it, and never its words', () => {
    const legacy: KnowledgeComment[] = [
      { id: 'gone', doc_id: 'd', parent_id: null, body: 'secret', author: 'u-jonas', created_at: '2026-09-20T10:00:00Z', deleted_at: '2026-09-20T11:00:00Z' },
      { id: 'reply', doc_id: 'd', parent_id: 'gone', body: 'Still here', author: 'u-farah', created_at: '2026-09-20T12:00:00Z' },
      { id: 'alone', doc_id: 'd', parent_id: null, body: 'nobody answered', author: 'u-farah', created_at: '2026-09-20T13:00:00Z', deleted_at: '2026-09-20T14:00:00Z' },
    ];
    const plan = planLegacyCommentImport(documentId, legacy, names);
    expect(plan.map(c => c.commentId)).toEqual(['gone', 'reply']);
    expect(plan[0]).toMatchObject({ text: 'This comment was removed.', deletedAt: '2026-09-20T11:00:00.000Z', scope: 'document' });
    expect(JSON.stringify(plan)).not.toContain('secret');
  });

  it('turns a reply whose parent is missing into a root rather than an orphan', () => {
    const [only] = planLegacyCommentImport(documentId, [
      { id: 'r', doc_id: 'd', parent_id: 'missing', body: 'x', author: 'someone', created_at: '2026-09-20T10:00:00Z' },
    ], names);
    expect(only).toMatchObject({ scope: 'document', displayName: 'someone' });
    expect(only).not.toHaveProperty('parentCommentId');
  });
});

it('normalises Aurora timestamptz text to ISO UTC instead of reading it as local time', () => {
  expect(isoTimestamp('2026-09-20 10:00:00+00')).toBe('2026-09-20T10:00:00.000Z');
  expect(isoTimestamp('2026-09-20 10:00:00.123456-04')).toBe('2026-09-20T14:00:00.123Z');
  expect(isoTimestamp('2026-09-20T10:00:00Z')).toBe('2026-09-20T10:00:00.000Z');
});

describe('ensureLegacyCommentsImported (dev:mock)', () => {
  it('imports the seeded page:100002 thread once, records it, and then refuses legacy writes', async () => {
    expect(await legacyThreadMoved('page:100002')).toBe(false);
    const first = await ensureLegacyCommentsImported('page:100002', documentId);
    expect(first).toMatchObject({ state: 'imported', imported: 2, legacy: 2 });
    const rows = platformDocumentCommentsFixture.rows().filter(r => r.documentId === documentId);
    expect(rows.map(r => [r.commentId, r.userId, r.parentCommentId ?? null])).toEqual([
      ['kc-rubric-01', 'u-jonas', null], ['kc-rubric-02', 'u-farah', 'kc-rubric-01'],
    ]);
    expect(await legacyThreadMoved('page:100002')).toBe(true);

    // A second read is one ledger lookup: nothing is written twice.
    const second = await ensureLegacyCommentsImported('page:100002', documentId);
    expect(second).toMatchObject({ state: 'imported', imported: 2, legacy: 2, importedAt: first.importedAt });
    expect(platformDocumentCommentsFixture.rows().filter(r => r.documentId === documentId)).toHaveLength(2);
  });

  it('records a document with no legacy thread as done, with nothing to move', async () => {
    expect(await ensureLegacyCommentsImported('page:100003', documentId)).toMatchObject({ state: 'none', imported: 0, legacy: 0 });
    expect(await legacyThreadMoved('page:100003')).toBe(true);
  });

  it('says so — and writes nothing — when platform-api is configured but the import table is not', async () => {
    process.env['DOCUMENT_PLATFORM_INTERNAL_URL'] = 'http://platform:3001';
    const status = await ensureLegacyCommentsImported('page:100002', documentId);
    expect(status).toMatchObject({ state: 'unconfigured', imported: 0, legacy: 2 });
    expect(platformDocumentCommentsFixture.rows()).toHaveLength(0);
    expect(await legacyThreadMoved('page:100002')).toBe(false);
  });
});

it('reads and writes the Aurora ledger with ON CONFLICT DO NOTHING', async () => {
  Object.assign(config.mock, { aurora: false });
  jest.mocked(exec).mockResolvedValue([]);
  expect(await legacyThreadMoved('page:1')).toBe(false);
  expect(String(jest.mocked(exec).mock.calls[0]![0])).toContain('assessment_document_comment_imports');
});

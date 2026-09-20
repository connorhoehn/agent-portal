jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
import { config } from '../../config.js';
import { exec } from '../aurora.js';
import { fixtureRegistry } from '../../mock/core/fixture.js';
import { ensureDocumentMapping, markDocumentMappingReady, documentSourceRevision, advanceDocumentSourceRevision } from '../document-mapping.js';

beforeEach(() => { Object.assign(config.mock, { aurora: true }); fixtureRegistry.get('assessment-document-mappings')!.reset(); });
it('concurrent opens share a short opaque channel and retain the seed revision', async () => {
  const revision = documentSourceRevision('body with ![image](/image.png)');
  const rows = await Promise.all(Array.from({ length: 12 }, () => ensureDocumentMapping('page:100002', revision)));
  expect(new Set(rows.map(row => row.document_id)).size).toBe(1);
  expect(`doc:${rows[0]!.document_id}`.length).toBeLessThanOrEqual(50);
  expect(await ensureDocumentMapping('page:100002', 'new-source')).toEqual(rows[0]);
  expect(await markDocumentMappingReady(rows[0]!.document_id, 'wrong')).toBe(false);
  expect(await markDocumentMappingReady(rows[0]!.document_id, revision)).toBe(true);
  expect((await ensureDocumentMapping('page:100002', revision)).migration_state).toBe('ready');
});
it('registered reset clears migration state', async () => {
  const original = await ensureDocumentMapping('local:a', 'rev');
  fixtureRegistry.get('assessment-document-mappings')!.reset();
  const reset = await ensureDocumentMapping('local:a', 'rev');
  expect(reset.document_id).toBe(original.document_id);
  expect(reset.migration_state).toBe('pending');
});
it('advances only the acknowledged publication base and rejects stale writers', async () => {
  const row = await ensureDocumentMapping('local:publication-test', 'import');
  expect(await advanceDocumentSourceRevision(row.document_id, 'import', 'published')).toBe(true);
  expect(await advanceDocumentSourceRevision(row.document_id, 'import', 'stale')).toBe(false);
  expect(await ensureDocumentMapping('local:publication-test', 'upstream')).toMatchObject({ source_revision: 'import', published_revision: 'published' });
  expect(await advanceDocumentSourceRevision(row.document_id, 'published', 'next')).toBe(true);
});
it('records a verified creator without letting a subsequent opener take ownership', async () => {
  const row = await ensureDocumentMapping('local:owned-test', 'import', 'creator');
  expect(row.owner_sub).toBe('creator');
  expect((await ensureDocumentMapping('local:owned-test', 'new-body', 'viewer')).owner_sub).toBe('creator');
});
it('uses one conflict-safe SQL statement for durable first-open races', async () => {
  Object.assign(config.mock, { aurora: false });
  jest.mocked(exec).mockResolvedValue([{ document_id: 'canonical' }]);
  expect((await ensureDocumentMapping("page:'unsafe", 'revision')).document_id).toBe('canonical');
  const [sql, params] = jest.mocked(exec).mock.calls.at(-1)!;
  expect(sql).toContain('ON CONFLICT (tenant_id, source_namespace, source_id) DO UPDATE');
  expect(sql).not.toContain("page:'unsafe");
  expect(params).toContainEqual({ name: 'source', value: { stringValue: "page:'unsafe" } });
});

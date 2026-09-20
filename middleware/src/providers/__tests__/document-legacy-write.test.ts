jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
import { assertLegacyDocumentWritable } from '../document-legacy-write.js';
import { ensureDocumentMapping, markDocumentMappingReady, documentMappingsFixture } from '../document-mapping.js';
const prior = process.env['DOCUMENT_GATEWAY_PUBLIC_URL'];
beforeEach(() => { documentMappingsFixture.reset(); delete process.env['DOCUMENT_GATEWAY_PUBLIC_URL']; });
afterAll(() => { if (prior === undefined) delete process.env['DOCUMENT_GATEWAY_PUBLIC_URL']; else process.env['DOCUMENT_GATEWAY_PUBLIC_URL'] = prior; });
it('blocks legacy writes once the binary import is durable even when the gateway is unavailable', async () => {
  const row = await ensureDocumentMapping('local:legacy-test', 'source');
  await markDocumentMappingReady(row.document_id, 'source');
  await expect(assertLegacyDocumentWritable('local:legacy-test')).rejects.toMatchObject({ status: 409 });
});
it('blocks legacy edits during import while retaining unmigrated Markdown documents', async () => {
  await expect(assertLegacyDocumentWritable('local:unmapped')).resolves.toBeUndefined();
  await ensureDocumentMapping('local:pending-test', 'source');
  process.env['DOCUMENT_GATEWAY_PUBLIC_URL'] = 'ws://localhost:18081';
  await expect(assertLegacyDocumentWritable('local:pending-test')).rejects.toMatchObject({ status: 409 });
});

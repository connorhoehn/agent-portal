jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
import { readFileSync } from 'node:fs';
import { exec } from '../aurora.js';
import { getDocumentRecord, linkWorkDocument, listWorkDocuments, searchDocumentRecords, unlinkWorkDocument } from '../work-documents.js';
beforeEach(() => jest.mocked(exec).mockReset());
it('uses canonical document joins and bounded literal search without turning database outages into an empty answer', async () => {
  jest.mocked(exec).mockResolvedValueOnce([{ id: 'doc:1', title: 'Current title', source: 'adr', source_uri: null, ingested_at: null, linked_by: 'author', linked_at: 'now' }]);
  expect(await listWorkDocuments('work-1')).toEqual([{ id: 'doc:1', title: 'Current title', source: 'adr', sourceUri: null,
    ingestedAt: null, linkedBy: 'author', linkedAt: 'now', href: '/iq/documents/doc%3A1' }]);
  expect(jest.mocked(exec).mock.calls[0]?.[0]).toContain('JOIN documents d ON d.id = l.document_id');
  jest.mocked(exec).mockResolvedValueOnce([]); await searchDocumentRecords('20%_\\');
  expect(jest.mocked(exec).mock.calls[1]?.[1]).toEqual([{ name: 'query', value: { stringValue: '%20\\%\\_\\\\%' } }]);
  jest.mocked(exec).mockRejectedValueOnce(new Error('relation "work_item_documents" does not exist'));
  await expect(listWorkDocuments('work-1')).rejects.toMatchObject({ status: 503 });
  jest.mocked(exec).mockRejectedValueOnce(new Error('Database unavailable'));
  await expect(getDocumentRecord('doc')).rejects.toThrow('Database unavailable');
});
it('uses an atomic foreign-key pair, retains duplicate attribution, and refuses a vanished pair', async () => {
  jest.mocked(exec).mockResolvedValueOnce([{ document_id: 'doc' }]);
  expect(await linkWorkDocument('work', 'doc', 'author')).toEqual({ created: true });
  const insert = jest.mocked(exec).mock.calls[0]![0];
  expect(insert).toContain('SELECT w.id, d.id, :actor'); expect(insert).toContain('ON CONFLICT (work_item_id, document_id) DO NOTHING');
  jest.mocked(exec).mockResolvedValueOnce([]).mockResolvedValueOnce([{ document_id: 'doc' }]);
  expect(await linkWorkDocument('work', 'doc', 'other')).toEqual({ created: false });
  jest.mocked(exec).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  await expect(linkWorkDocument('work', 'missing', 'author')).rejects.toMatchObject({ status: 404 });
  jest.mocked(exec).mockResolvedValueOnce([{ document_id: 'doc' }]); expect(await unlinkWorkDocument('work', 'doc')).toBe(true);
  const schema = readFileSync(`${process.cwd()}/../schema/work_item_documents_schema.sql`, 'utf8');
  expect(schema).toContain('REFERENCES documents(id) ON DELETE CASCADE'); expect(schema).toContain('PRIMARY KEY (work_item_id, document_id)');
});

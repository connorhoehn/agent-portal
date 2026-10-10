import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeWorkDocument, documentRecordHref, documentSourceHref, readDocumentRecord, readWorkDocuments } from '../workDocuments.ts';
const doc = { id: 'doc:1', title: 'Canonical title', source: 'adr', sourceUri: null, ingestedAt: null };
test('document records keep exact identity and safe source navigation', () => {
  assert.equal(documentRecordHref(doc.id), '/iq/documents/doc%3A1'); assert.deepEqual(readDocumentRecord(doc, doc.id), doc);
  assert.deepEqual(readWorkDocuments({ workItemId: 'work', documents: [doc] }, 'work'), [doc]);
  assert.throws(() => readDocumentRecord(doc, 'other')); assert.throws(() => readWorkDocuments({ workItemId: 'other', documents: [doc] }, 'work'));
  assert.throws(() => readDocumentRecord({ ...doc, id: '../private' }, '../private'));
  assert.equal(documentSourceHref('https://docs.example/source?id=1'), 'https://docs.example/source?id=1');
  for (const value of ['javascript:alert(1)', '//docs.example/source', 'https://user:pass@docs.example/', 's3://bucket/object', 'https://docs.example/\\private']) {
    assert.equal(documentSourceHref(value), null);
  }
});
test('association changes use opaque path identity, no client-resolved metadata, and require exact receipts', async () => {
  const original = globalThis.fetch; const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify({ workItemId: 'work', documentId: 'doc:1', created: true, removed: false })); };
  try {
    await changeWorkDocument('work', 'doc:1', 'PUT'); await changeWorkDocument('work', 'doc:1', 'DELETE');
    assert.equal(requests[0]!.url, '/api/graph/work-items/work/documents/doc%3A1'); assert.equal(requests[0]!.init?.body, undefined);
    assert.equal(requests[0]!.init?.credentials, 'include'); assert.equal(requests[1]!.init?.method, 'DELETE');
    globalThis.fetch = async () => new Response(JSON.stringify({ workItemId: 'other', documentId: 'doc:1', created: true }));
    await assert.rejects(changeWorkDocument('work', 'doc:1', 'PUT'), /not confirmed/);
  } finally { globalThis.fetch = original; }
});

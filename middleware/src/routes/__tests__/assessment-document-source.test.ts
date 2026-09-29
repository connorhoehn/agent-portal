jest.mock('../../providers/document-drafts.js', () => ({ createDocumentDraft: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));
jest.mock('../../providers/assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
jest.mock('../../providers/document-source.js', () => ({
  DocumentSourceError: class extends Error { constructor(public status: number, message: string) { super(message); } },
  sourceConfigured: () => true, previewSourceChanges: jest.fn(), publishSourcePage: jest.fn(), pullSourcePage: jest.fn(), readSourceAsset: jest.fn(),
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [
  { id: 'assessor', tenant: 'assessment', capabilities: ['ViewAssessment'] },
  { id: 'lead-assessor', tenant: 'assessment', capabilities: ['ViewAssessment', 'ManageKnowledge'] },
] }));
import express from 'express';
import request from '../../test-support/http.js';
import { assessmentDocumentSourceRouter } from '../assessment-document-source.js';
import { getKnowledgeDoc } from '../../providers/assessment.js';
import { publishSourcePage, readSourceAsset } from '../../providers/document-source.js';
import { createDocumentDraft } from '../../providers/document-drafts.js';
import { DRAFT_MARKDOWN_MAX } from '../assessment-document-source.js';
import type { Session } from '../../lib/session.js';
const viewer: Session = { sub: 'reader', role: 'assessor', tenant: 'assessment', grants: { assessment: ['assessor'] }, iat: 1 };
function app(session = viewer) {
  return express().use(express.json()).use((req, _res, next) => { req.session = session; next(); })
    .use('/api/assessment/knowledge', assessmentDocumentSourceRouter);
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getKnowledgeDoc).mockResolvedValue({ id: 'page:100002', title: 'Doc', markdown: '# Doc', classification: 'synced', path: '', editable: false, updated_at: '' });
  jest.mocked(publishSourcePage).mockResolvedValue({ published: true });
});
it('requires write capability before projecting or publishing', async () => {
  const res = await request(app()).post('/api/assessment/knowledge/source/publish').send({ id: 'page:100002' });
  expect(res.status).toBe(403); expect(publishSourcePage).not.toHaveBeenCalled();
});
it('rejects raw content and requires the reviewed revision and projection hash', async () => {
  const lead: Session = { ...viewer, role: 'lead-assessor' };
  for (const body of [{ id: 'page:100002', markdown: 'forged' }, { id: 'page:100002' }]) {
    expect((await request(app(lead)).post('/api/assessment/knowledge/source/publish').send(body)).status).toBe(400);
  }
  expect(publishSourcePage).not.toHaveBeenCalled();
});
it('delegates only source identity and the reviewed comparison fields', async () => {
  const lead: Session = { ...viewer, role: 'lead-assessor' };
  const expected = { sourceRevision: 'a'.repeat(64), projectionHash: 'b'.repeat(64) };
  expect((await request(app(lead)).post('/api/assessment/knowledge/source/publish').send({ id: 'page:100002', ...expected })).status).toBe(200);
  expect(publishSourcePage).toHaveBeenCalledWith(expect.objectContaining({ id: 'page:100002' }), lead, expected);
});
it('serves source assets with private response headers', async () => {
  jest.mocked(readSourceAsset).mockResolvedValue({ bytes: Buffer.from('image'), contentType: 'image/png' });
  const res = await request(app()).get('/api/assessment/knowledge/source/asset?id=page%3A100002&name=diagram.png');
  expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('private, no-store');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(readSourceAsset).toHaveBeenCalledWith('page:100002', 'diagram.png');
});
it('doc/create takes an uploaded body as a string within the ceiling, and nothing else', async () => {
  const lead: Session = { ...viewer, role: 'lead-assessor' };
  jest.mocked(createDocumentDraft).mockResolvedValue({ ok: true, id: 'draft:x', documentId: 'uuid', title: 'Notes' });
  const ok = await request(app(lead)).post('/api/assessment/knowledge/doc/create').send({ title: 'Notes', sectionKey: 'workspace_drafts', markdown: '# Notes' });
  expect(ok.status).toBe(201);
  expect(createDocumentDraft).toHaveBeenCalledWith({ title: 'Notes', sectionKey: 'workspace_drafts', markdown: '# Notes' }, lead);
  for (const markdown of [42, 'x'.repeat(DRAFT_MARKDOWN_MAX + 1)]) {
    expect((await request(app(lead)).post('/api/assessment/knowledge/doc/create').send({ title: 'Notes', sectionKey: 'workspace_drafts', markdown })).status).toBe(400);
  }
  expect(createDocumentDraft).toHaveBeenCalledTimes(1);
});

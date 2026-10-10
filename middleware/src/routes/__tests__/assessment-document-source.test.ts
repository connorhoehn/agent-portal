jest.mock('../../providers/document-drafts.js', () => ({ createDocumentDraft: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));
jest.mock('../../providers/assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
jest.mock('../../providers/document-source.js', () => ({
  DocumentSourceError: class extends Error { constructor(public status: number, message: string) { super(message); } },
  sourceConfigured: jest.fn(() => true), previewSourceChanges: jest.fn(), publishSourcePage: jest.fn(), pullSourcePage: jest.fn(), readSourceAsset: jest.fn(), moveSourcePage: jest.fn(),
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [
  { id: 'assessor', tenant: 'assessment', capabilities: ['ViewAssessment'] },
  { id: 'lead-assessor', tenant: 'assessment', capabilities: ['ViewAssessment', 'ManageKnowledge'] },
] }));
import express from 'express';
import request from '../../test-support/http.js';
import { assessmentDocumentSourceRouter } from '../assessment-document-source.js';
import { getKnowledgeDoc } from '../../providers/assessment.js';
import { publishSourcePage, readSourceAsset, previewSourceChanges, pullSourcePage, moveSourcePage, sourceConfigured, DocumentSourceError } from '../../providers/document-source.js';
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
  jest.mocked(sourceConfigured).mockReturnValue(true);
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

describe('preview and pull', () => {
  const lead: Session = { ...viewer, role: 'lead-assessor' };
  it('a reader without ManageKnowledge is refused before any source read', async () => {
    for (const path of ['/api/assessment/knowledge/source/preview', '/api/assessment/knowledge/source/pull']) {
      expect((await request(app()).post(path).send({ id: 'page:100002' })).status).toBe(403);
    }
    expect((await request(app({ ...lead, tenant: 'orgiq', role: 'member' })).post('/api/assessment/knowledge/source/preview').send({ id: 'page:100002' })).status).toBe(403);
    expect(getKnowledgeDoc).not.toHaveBeenCalled(); expect(previewSourceChanges).not.toHaveBeenCalled(); expect(pullSourcePage).not.toHaveBeenCalled();
  });
  it('take only the document id — publish-only or raw content fields are 400', async () => {
    for (const body of [{ id: 'page:100002', projectionHash: 'b'.repeat(64) }, { id: 'page:100002', markdown: 'forged' }, { id: '' }, {}]) {
      expect((await request(app(lead)).post('/api/assessment/knowledge/source/preview').send(body)).status).toBe(400);
      expect((await request(app(lead)).post('/api/assessment/knowledge/source/pull').send(body)).status).toBe(400);
    }
    expect(previewSourceChanges).not.toHaveBeenCalled(); expect(pullSourcePage).not.toHaveBeenCalled();
  });
  it('preview resolves the source server-side and returns the comparison, no-store', async () => {
    jest.mocked(previewSourceChanges).mockResolvedValue({ sourceRevision: 'a'.repeat(64), projectionHash: 'b'.repeat(64), changed: true } as never);
    const res = await request(app(lead)).post('/api/assessment/knowledge/source/preview').send({ id: 'page:100002' });
    expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ sourceRevision: 'a'.repeat(64), projectionHash: 'b'.repeat(64), changed: true });
    expect(getKnowledgeDoc).toHaveBeenCalledWith('page:100002');
    expect(previewSourceChanges).toHaveBeenCalledWith(expect.objectContaining({ id: 'page:100002', title: 'Doc' }), lead);
    expect(pullSourcePage).not.toHaveBeenCalled();
  });
  it('pull goes to pullSourcePage, never preview', async () => {
    jest.mocked(pullSourcePage).mockResolvedValue({ pulled: true } as never);
    const res = await request(app(lead)).post('/api/assessment/knowledge/source/pull').send({ id: 'page:100002' });
    expect(res.status).toBe(200); expect(res.body).toEqual({ pulled: true });
    expect(pullSourcePage).toHaveBeenCalledWith(expect.objectContaining({ id: 'page:100002' }), lead);
    expect(previewSourceChanges).not.toHaveBeenCalled();
  });
  it('an unknown document is 404; an unconfigured source is 503; provider errors keep their status', async () => {
    jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null);
    expect((await request(app(lead)).post('/api/assessment/knowledge/source/pull').send({ id: 'page:missing' })).status).toBe(404);
    jest.mocked(sourceConfigured).mockReturnValueOnce(false);
    const off = await request(app(lead)).post('/api/assessment/knowledge/source/preview').send({ id: 'page:100002' });
    expect(off.status).toBe(503); expect(off.body.error).toBe('Document source is not configured');
    jest.mocked(pullSourcePage).mockRejectedValueOnce(new DocumentSourceError(409, 'Source changed since preview'));
    const conflict = await request(app(lead)).post('/api/assessment/knowledge/source/pull').send({ id: 'page:100002' });
    expect(conflict.status).toBe(409); expect(conflict.body.error).toBe('Source changed since preview');
    expect(pullSourcePage).toHaveBeenCalledTimes(1);
  });
});

describe('move', () => {
  const lead: Session = { ...viewer, role: 'lead-assessor' };
  it('requires ManageKnowledge', async () => {
    expect((await request(app()).post('/api/assessment/knowledge/source/move').send({ id: 'page:1', parentId: 'page:2', position: 0 })).status).toBe(403);
    expect(moveSourcePage).not.toHaveBeenCalled();
  });
  it('requires a page, a parent and a nonnegative integer position, and nothing else', async () => {
    for (const body of [
      { id: 'page:1', parentId: 'page:2' }, { id: 'page:1', parentId: 'page:2', position: -1 }, { id: 'page:1', parentId: 'page:2', position: 1.5 },
      { id: 'page:1', parentId: 2, position: 0 }, { id: 'page:1', parentId: 'page:2', position: 0, space: 'OTHER' },
    ]) expect((await request(app(lead)).post('/api/assessment/knowledge/source/move').send(body)).status).toBe(400);
    expect(moveSourcePage).not.toHaveBeenCalled();
  });
  it('delegates the move with the session as actor and returns its result', async () => {
    jest.mocked(moveSourcePage).mockResolvedValue({ moved: true, parentId: 'page:2', position: 3 } as never);
    const res = await request(app(lead)).post('/api/assessment/knowledge/source/move').send({ id: 'page:1', parentId: 'page:2', position: 3 });
    expect(res.status).toBe(200); expect(res.body).toEqual({ moved: true, parentId: 'page:2', position: 3 });
    expect(moveSourcePage).toHaveBeenCalledWith('page:1', 'page:2', 3, lead);
  });
  it('an unexpected failure is 503 with the check-state message', async () => {
    jest.mocked(moveSourcePage).mockRejectedValueOnce(new Error('ECONNRESET'));
    const res = await request(app(lead)).post('/api/assessment/knowledge/source/move').send({ id: 'page:1', parentId: 'page:2', position: 0 });
    expect(res.status).toBe(503); expect(res.body.error).toMatch(/Check its recorded state/);
  });
});

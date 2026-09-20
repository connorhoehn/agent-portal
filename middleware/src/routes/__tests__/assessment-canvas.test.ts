jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));
jest.mock('../../providers/assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
jest.mock('../../providers/document-canvas.js', () => ({ connectDocumentCanvas: jest.fn() }));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [
  {id:'admin',tenant:null,label:'Admin',summary:'',capabilities:['*']},
  { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: ['ViewAssessment'] },
  { id: 'lead-assessor', tenant: 'assessment', label: 'Lead', summary: '', capabilities: ['ViewAssessment', 'ManageKnowledge'] },
] }));
import express from 'express';
import request from '../../test-support/http.js';
import { assessmentCanvasRouter } from '../assessment-canvas.js';
import { getKnowledgeDoc } from '../../providers/assessment.js';
import { connectDocumentCanvas } from '../../providers/document-canvas.js';
import type { Session } from '../../lib/session.js';

const user: Session = { sub: 'viewer', role: 'assessor', tenant: 'assessment', grants: { assessment: ['assessor'] }, iat: 0 };
function app(session: Session = user) {
  return express().use(express.json()).use((req, _res, next) => { req.session = session; next(); })
    .use('/api/assessment/knowledge', assessmentCanvasRouter);
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getKnowledgeDoc).mockResolvedValue({ id: 'page:100002', title: 'Rubric', classification: 'synced', markdown: '# Rubric',
    path: 'confluence/100002', editable: false, updated_at: '2026-09-20T10:00:00Z' });
  jest.mocked(connectDocumentCanvas).mockResolvedValue({ documentId: 'canonical', sourceId: 'page:100002', title: 'Rubric', classification: 'synced',
    canEdit: false, canManageWorkflow: false, gatewayUrl: 'ws://localhost:18081', token: 'grant', expiresAt: Date.now() + 120000, sourceRevision: 'revision' });
});
it('never accepts browser-supplied identity or editing authority', async () => {
  const response = await request(app()).post('/api/assessment/knowledge/canvas').send({ id: 'page:100002', canEdit: true, sub: 'admin' });
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(connectDocumentCanvas).toHaveBeenCalledWith(expect.objectContaining({ id: 'page:100002' }), user, false);
});
it('allows authorized local drafts of synced sources', async () => {
  const lead: Session = { ...user, role: 'lead-assessor', grants: { assessment: ['lead-assessor'] } };
  expect((await request(app(lead)).post('/api/assessment/knowledge/canvas').send({ id: 'page:100002' })).status).toBe(200);
  expect(connectDocumentCanvas).toHaveBeenCalledWith(expect.anything(), lead, true);
});
it('keeps prompt mirrors read-only even for knowledge managers', async () => {
  const lead: Session = { ...user, role: 'lead-assessor' };
  expect((await request(app(lead)).post('/api/assessment/knowledge/canvas').send({ id: 'prompt:instructions' })).status).toBe(200);
  expect(connectDocumentCanvas).toHaveBeenCalledWith(expect.anything(), lead, false);
});
it('rejects other tenants before contacting document storage', async () => {
  expect((await request(app({ ...user, tenant: 'orgiq', role: 'member' })).post('/api/assessment/knowledge/canvas').send({ id: 'page:100002' })).status).toBe(403);
  expect(getKnowledgeDoc).not.toHaveBeenCalled();
});
it('does not mint access for a missing source', async () => {
  jest.mocked(getKnowledgeDoc).mockResolvedValueOnce(null);
  expect((await request(app()).post('/api/assessment/knowledge/canvas').send({ id: 'missing' })).status).toBe(404);
  expect(connectDocumentCanvas).not.toHaveBeenCalled();
});

it('requires the current assessment tenant even for a global administrator with assessment grants',async()=>{
 const admin:Session={...user,tenant:'orgiq',role:'admin',grants:{orgiq:['admin'],assessment:['admin']}};
 const response=await request(app(admin)).post('/api/assessment/knowledge/canvas').send({id:'page:100002'});
 expect(response.status).toBe(403);
 expect(response.body.error).toContain('Switch to the assessment tenant');
 expect(getKnowledgeDoc).not.toHaveBeenCalled();
 expect(connectDocumentCanvas).not.toHaveBeenCalled();
});

import { Router, type Request, type Response } from 'express';
import { requireAction, requireTenant } from '../lib/authz.js';
import { getKnowledgeDoc } from '../providers/assessment.js';
import { createDocumentDraft } from '../providers/document-drafts.js';
import { DocumentSourceError, previewSourceChanges, publishSourcePage, pullSourcePage, readSourceAsset, sourceConfigured } from '../providers/document-source.js';

export const assessmentDocumentSourceRouter = Router();
assessmentDocumentSourceRouter.use('/source', requireTenant('assessment'), requireAction('ViewAssessment'));
assessmentDocumentSourceRouter.post('/doc/create', requireTenant('assessment'), requireAction('ManageKnowledge'), async (req, res) => {
  if (!req.session) { res.status(401).json({ error: 'Sign in to create documents' }); return; }
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['title', 'sectionKey', 'parentId', 'sourceParentId'].includes(key))
    || typeof input.title !== 'string' || typeof input.sectionKey !== 'string'
    || (input.parentId !== undefined && input.parentId !== null && typeof input.parentId !== 'string')
    || (input.sourceParentId !== undefined && typeof input.sourceParentId !== 'string')) {
    res.status(400).json({ error: 'Invalid draft fields' }); return;
  }
  try { res.status(201).json(await createDocumentDraft(input, req.session)); }
  catch (error) { failure(error, res); }
});
function failure(error: unknown, res: Response) {
  if (error instanceof DocumentSourceError) res.status(error.status).json({ error: error.message });
  else res.status(503).json({ error: 'Document source is unavailable. Check its recorded state before retrying changes.' });
}
assessmentDocumentSourceRouter.get('/source/asset', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const { id, name } = req.query;
  if (typeof id !== 'string' || typeof name !== 'string') { res.status(400).json({ error: 'Document id and asset name required' }); return; }
  try {
    const asset = await readSourceAsset(id, name);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(asset.contentType).send(asset.bytes);
  } catch (error) { failure(error, res); }
});
function mutation(action: 'preview' | 'publish' | 'pull') {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.session) { res.status(401).json({ error: 'Sign in to change source documents' }); return; }
    const body: unknown = req.body;
    const fields = action === 'publish' ? ['id', 'projectionHash', 'sourceRevision'] : ['id'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) {
      res.status(400).json({ error: 'Invalid source operation fields' }); return;
    }
    const input = body as Record<string, unknown>;
    if (typeof input.id !== 'string' || !input.id || input.id.length > 1024) { res.status(400).json({ error: 'Document id required' }); return; }
    try {
      if (!sourceConfigured()) throw new DocumentSourceError(503, 'Document source is not configured');
      const source = await getKnowledgeDoc(input.id);
      if (!source) { res.status(404).json({ error: 'Document not found' }); return; }
      if (action === 'publish') {
        if (typeof input.projectionHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.projectionHash)
          || typeof input.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceRevision)) {
          res.status(400).json({ error: 'Review the current source changes before publishing' }); return;
        }
        res.json(await publishSourcePage(source, req.session, { projectionHash: input.projectionHash, sourceRevision: input.sourceRevision }));
      } else res.json(await (action === 'preview' ? previewSourceChanges : pullSourcePage)(source, req.session));
    } catch (error) { failure(error, res); }
  };
}
assessmentDocumentSourceRouter.post('/source/preview', requireAction('ManageKnowledge'), mutation('preview'));
assessmentDocumentSourceRouter.post('/source/publish', requireAction('ManageKnowledge'), mutation('publish'));
assessmentDocumentSourceRouter.post('/source/pull', requireAction('ManageKnowledge'), mutation('pull'));

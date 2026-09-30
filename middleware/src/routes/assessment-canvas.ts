import { Router } from 'express';
import { isAllowed, requireAction, requireTenant } from '../lib/authz.js';
import { getKnowledgeDoc } from '../providers/assessment.js';
import { connectDocumentCanvas } from '../providers/document-canvas.js';
import { canvasSourceEditable } from '../providers/document-editability.js';

export const assessmentCanvasRouter = Router();
assessmentCanvasRouter.post('/canvas', requireTenant('assessment'), requireAction('ViewAssessment'), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = req.body?.id;
  if (typeof id !== 'string' || !id || id.length > 1024) { res.status(400).json({ error: 'document id required' }); return; }
  // A real session identity. The demo persona has no identity row; outside
  // production lib/document-session.ts gives it epoch 0, so it gets the same
  // canvas as everyone else rather than the reader fallback.
  const session = req.session;
  if (!session) { res.status(401).json({ error: 'Sign in to open collaborative documents' }); return; }
  if (session.tenant !== 'assessment') { res.status(403).json({ error: 'Switch to the assessment tenant before opening documents' }); return; }
  try {
    const source = await getKnowledgeDoc(id);
    if (!source) { res.status(404).json({ error: 'document not found' }); return; }
    // Every signed-in assessment session gets a grant; edit only when the role
    // may (ManageKnowledge). Prompts edit through a draft (canvasSourceEditable).
    const canEdit = canvasSourceEditable(source) && await isAllowed(session, 'ManageKnowledge');
    res.json(await connectDocumentCanvas(source, session, canEdit));
  } catch (error) {
    console.error('document canvas connection failed', error instanceof Error ? error.message : 'unknown error');
    res.status(503).json({ error: 'Document collaboration is unavailable. Your existing document is preserved.' });
  }
});

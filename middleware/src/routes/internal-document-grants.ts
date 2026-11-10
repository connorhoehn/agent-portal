import { Router } from 'express';
import { DOCUMENT_POLICY_SERVICE_AUTH, hasServiceAuth, serviceAuthConfigured } from '../lib/service-auth.js';
import { currentDocumentSessionEpoch } from '../lib/document-session.js';

export const internalDocumentGrantsRouter = Router();

internalDocumentGrantsRouter.post('/session', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // This reads identity authority: unlike dev machine write callbacks it must
  // never open when its shared credential is absent.
  if (!serviceAuthConfigured(DOCUMENT_POLICY_SERVICE_AUTH)) {
    res.status(503).json({ error: 'document policy authentication unavailable' }); return;
  }
  if (!(await hasServiceAuth(req, DOCUMENT_POLICY_SERVICE_AUTH))) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  const { sub, tenantId, sessionId } = req.body ?? {};
  if (typeof sub !== 'string' || sub.length > 256 || !sub
    || tenantId !== 'assessment' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) {
    res.status(400).json({ error: 'invalid document session reference' }); return;
  }
  try {
    res.json({ epoch: await currentDocumentSessionEpoch(sub, tenantId, sessionId) });
  } catch {
    res.status(503).json({ error: 'document identity authority unavailable' });
  }
});

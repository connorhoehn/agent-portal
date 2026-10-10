import { Router, type Request, type Response } from 'express';
import { DocumentProposalError, parseDocumentProposal, parseDocumentProposalDecision, parseDocumentProposalRevision, proposalId } from '../lib/document-proposals.js';
import { createDocumentProposal, decideDocumentProposal, getDocumentProposal, listDocumentProposals, reviseDocumentProposal } from '../providers/document-proposals.js';

export const assessmentDocumentProposalsRouter = Router();
function handle(run: (req: Request, id: string, session: NonNullable<Request['session']>) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.session) { res.status(401).json({ error: 'Sign in to use proposed edits' }); return; }
    const id = req.query['id'];
    if (typeof id !== 'string' || !id || id.length > 1024) { res.status(400).json({ error: 'Document id required' }); return; }
    try { res.json(await run(req, id, req.session)); }
    catch (error) {
      if (error instanceof DocumentProposalError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(503).json({ error: 'Proposed edits are unavailable. Please retry.' });
    }
  };
}
assessmentDocumentProposalsRouter.get('/doc/proposals', handle((_req, id, session) => listDocumentProposals(id, session)));
assessmentDocumentProposalsRouter.get('/doc/proposals/:proposalId', handle((req, id, session) => getDocumentProposal(id, session, proposalId(req.params['proposalId']))));
assessmentDocumentProposalsRouter.post('/doc/proposals', handle((req, id, session) => createDocumentProposal(id, session, parseDocumentProposal(req.body))));
assessmentDocumentProposalsRouter.post('/doc/proposals/:proposalId/revision', handle((req, id, session) =>
  reviseDocumentProposal(id, session, proposalId(req.params['proposalId']), parseDocumentProposalRevision(req.body))));
assessmentDocumentProposalsRouter.post('/doc/proposals/:proposalId/decision', handle((req, id, session) => {
  const decision = parseDocumentProposalDecision(req.body);
  return decideDocumentProposal(id, session, String(req.params['proposalId'] ?? ''), decision.action, decision.version);
}));

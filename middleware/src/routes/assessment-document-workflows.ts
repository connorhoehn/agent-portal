import { Router, type Request } from 'express';
import { requireAction, requireTenant } from '../lib/authz.js';
import { DocumentWorkflowError, performDocumentWorkflow, type WorkflowOperation } from '../providers/document-workflows.js';

export const assessmentDocumentWorkflowsRouter = Router();
const router = Router();
assessmentDocumentWorkflowsRouter.use('/doc/workflows', requireTenant('assessment'), requireAction('ViewAssessment'), router);

function parameter(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string') throw new DocumentWorkflowError(400, 'Invalid workflow resource');
  return value;
}
function body(req: Request, fields: string[]): Record<string, unknown> {
  const value: unknown = req.body ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw new DocumentWorkflowError(400, 'Invalid workflow fields');
  return value as Record<string, unknown>;
}
function handle(makeOperation: (req: Request) => WorkflowOperation) {
  return async (req: Request, res: import('express').Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.session) { res.status(401).json({ error: 'Sign in to use document workflows' }); return; }
    const id = req.query['id'];
    if (typeof id !== 'string' || !id || id.length > 1024) { res.status(400).json({ error: 'Document id required' }); return; }
    try {
      const result = await performDocumentWorkflow(id, req.session, makeOperation(req));
      res.status(result.status).json(result.body);
    } catch (error) {
      if (error instanceof DocumentWorkflowError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(503).json({ error: 'Document workflows are unavailable. Please retry.' });
    }
  };
}
router.get('/', handle(() => ({ kind: 'lifecycle', method: 'GET' })));
router.post('/transitions', handle(req => ({ kind: 'transition', method: 'POST', body: body(req, ['action', 'reason']) })));
router.post('/ownership', handle(req => ({ kind: 'ownership', method: 'POST', body: body(req, []) })));
router.get('/review-requests', handle(() => ({ kind: 'review-requests', method: 'GET' })));
router.post('/review-requests', handle(req => ({ kind: 'request-review', method: 'POST', body: body(req, ['reviewerId', 'sectionId', 'dueDate', 'note', 'required']) })));
router.patch('/review-requests/:requestKey', handle(req => ({ kind: 'update-review', method: 'PATCH', requestKey: parameter(req, 'requestKey'), body: body(req, ['state', 'comment', 'dueDate']) })));
router.get('/reviews', handle(() => ({ kind: 'reviews', method: 'GET' })));
router.get('/sections/:sectionId/items', handle(req => ({ kind: 'items', method: 'GET', sectionId: parameter(req, 'sectionId') })));
router.post('/sections/:sectionId/items/:itemId/ack', handle(req => ({ kind: 'item-ack', method: 'POST', sectionId: parameter(req, 'sectionId'), itemId: parameter(req, 'itemId'), body: body(req, []) })));
router.post('/sections/:sectionId/items/:itemId/answer', handle(req => ({ kind: 'item-answer', method: 'POST', sectionId: parameter(req, 'sectionId'), itemId: parameter(req, 'itemId'), body: body(req, ['answer']) })));

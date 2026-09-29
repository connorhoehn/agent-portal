import { changeDocumentVersion, type DocumentVersionChange } from '../providers/document-versions.js';
import { Router, type Request } from 'express';
import { requireAction, requireTenant } from '../lib/authz.js';
import { DocumentWorkflowError, performDocumentWorkflow, listDocumentReviewers, type WorkflowOperation } from '../providers/document-workflows.js';
import { createDocumentComment, deleteDocumentComment, listDocumentComments, updateDocumentComment, type DocumentCommentResult } from '../providers/document-comments.js';

export const assessmentDocumentWorkflowsRouter = Router();
assessmentDocumentWorkflowsRouter.use('/doc/workflows', requireTenant('assessment'), requireAction('ViewAssessment'));

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
function handle(makeOperation: (req: Request) => WorkflowOperation | DocumentVersionChange | { directory: true }) {
  return async (req: Request, res: import('express').Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.session) { res.status(401).json({ error: 'Sign in to use document workflows' }); return; }
    const id = req.query['id'];
    if (typeof id !== 'string' || !id || id.length > 1024) { res.status(400).json({ error: 'Document id required' }); return; }
    try {
      const operation = makeOperation(req);
      const result = 'directory' in operation
        ? { status: 200, body: await listDocumentReviewers(id, req.session) }
        : 'action' in operation
        ? { status: 200, body: await changeDocumentVersion(id, req.session, operation) }
        : await performDocumentWorkflow(id, req.session, operation);
      res.status(result.status).json(result.body);
    } catch (error) {
      if (error instanceof DocumentWorkflowError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(503).json({ error: 'Document workflows are unavailable. Please retry.' });
    }
  };
}
assessmentDocumentWorkflowsRouter.get('/doc/workflows', handle(() => ({ kind: 'lifecycle', method: 'GET' })));
assessmentDocumentWorkflowsRouter.post('/doc/workflows/transitions', handle(req => ({ kind: 'transition', method: 'POST', body: body(req, ['action', 'reason']) })));
assessmentDocumentWorkflowsRouter.post('/doc/workflows/ownership', handle(req => ({ kind: 'ownership', method: 'POST', body: body(req, []) })));
assessmentDocumentWorkflowsRouter.get('/doc/workflows/review-requests', handle(() => ({ kind: 'review-requests', method: 'GET' })));
assessmentDocumentWorkflowsRouter.post('/doc/workflows/review-requests', handle(req => ({ kind: 'request-review', method: 'POST', body: body(req, ['reviewerId', 'sectionId', 'dueDate', 'note', 'required']) })));
assessmentDocumentWorkflowsRouter.patch('/doc/workflows/review-requests/:requestKey', handle(req => ({ kind: 'update-review', method: 'PATCH', requestKey: parameter(req, 'requestKey'), body: body(req, ['state', 'comment', 'dueDate']) })));
assessmentDocumentWorkflowsRouter.get('/doc/workflows/reviews', handle(() => ({ kind: 'reviews', method: 'GET' })));
assessmentDocumentWorkflowsRouter.get('/doc/workflows/sections/:sectionId/items', handle(req => ({ kind: 'items', method: 'GET', sectionId: parameter(req, 'sectionId') })));
assessmentDocumentWorkflowsRouter.post('/doc/workflows/sections/:sectionId/items/:itemId/ack', handle(req => ({ kind: 'item-ack', method: 'POST', sectionId: parameter(req, 'sectionId'), itemId: parameter(req, 'itemId'), body: body(req, []) })));
assessmentDocumentWorkflowsRouter.post('/doc/workflows/sections/:sectionId/items/:itemId/answer', handle(req => ({ kind: 'item-answer', method: 'POST', sectionId: parameter(req, 'sectionId'), itemId: parameter(req, 'itemId'), body: body(req, ['answer']) })));

assessmentDocumentWorkflowsRouter.post('/doc/workflows/versions', handle(req => {
  const value = body(req, ['name']);
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200)) throw new DocumentWorkflowError(400, 'Version name must be at most 200 characters');
  return { action: 'save', ...(typeof value.name === 'string' ? { name: value.name } : {}) };
}));
assessmentDocumentWorkflowsRouter.post('/doc/workflows/versions/restore', handle(req => {
  const value = body(req, ['timestamp']);
  if (typeof value.timestamp !== 'number' || !Number.isSafeInteger(value.timestamp) || value.timestamp <= 0) throw new DocumentWorkflowError(400, 'Version timestamp required');
  return { action: 'restore', timestamp: value.timestamp };
}));

assessmentDocumentWorkflowsRouter.get('/doc/workflows/reviewers', handle(() => ({ directory: true })));

// Document comments on platform-api threads (providers/document-comments.ts).
// The browser names the SOURCE id; the canonical document, the actor and the
// credential are the BFF's. Reads carry the one-time legacy import's status.
function handleComments(run: (req: Request, id: string, session: NonNullable<Request['session']>) => Promise<DocumentCommentResult>) {
  return async (req: Request, res: import('express').Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!req.session) { res.status(401).json({ error: 'Sign in to use document comments' }); return; }
    const id = req.query['id'];
    if (typeof id !== 'string' || !id || id.length > 1024) { res.status(400).json({ error: 'Document id required' }); return; }
    try {
      const result = await run(req, id, req.session);
      if (result.status === 204) { res.status(204).end(); return; }
      res.status(result.status).json(result.body);
    } catch (error) {
      if (error instanceof DocumentWorkflowError) { res.status(error.status).json({ error: error.message }); return; }
      res.status(503).json({ error: 'Document comments are unavailable. Please retry.' });
    }
  };
}
assessmentDocumentWorkflowsRouter.get('/doc/workflows/comments', handleComments(async (_req, id, session) => ({ status: 200, body: { ...await listDocumentComments(id, session) } })));
assessmentDocumentWorkflowsRouter.post('/doc/workflows/comments', handleComments((req, id, session) => createDocumentComment(id, session, req.body ?? {})));
assessmentDocumentWorkflowsRouter.patch('/doc/workflows/comments/:commentId', handleComments((req, id, session) => updateDocumentComment(id, session, req.params['commentId'], req.body ?? {})));
assessmentDocumentWorkflowsRouter.delete('/doc/workflows/comments/:commentId', handleComments((req, id, session) => deleteDocumentComment(id, session, req.params['commentId'])));

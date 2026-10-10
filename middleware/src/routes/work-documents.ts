import { Router, type Request } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { currentLiveSession } from '../lib/live-principal.js';
import { isAllowed } from '../lib/authz.js';
import { getWorkItem } from '../providers/work-items.js';
import { notifyWorkGraphChanged } from '../lib/work-graph/live.js';
import { documentRecordHref, getDocumentRecord, linkWorkDocument, listWorkDocuments, searchDocumentRecords, unlinkWorkDocument } from '../providers/work-documents.js';
import type { Session } from '../lib/session.js';

export const workDocumentsRouter = Router();
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(value)) throw new ValidationError('Invalid resource id');
  return value;
}
async function authority(source: Session | undefined, write = false): Promise<Session> {
  if (!source) throw new AppError(401, 'Unauthenticated');
  const session = await currentLiveSession(source);
  if (session.tenant !== 'orgiq') throw new AppError(403, 'Choose a Work workspace to read its document records');
  if (write && !await isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, 'DispatchAgentRun')) {
    throw new AppError(403, 'Your role cannot change work context');
  }
  // A remote policy read may outlive a directory epoch/grant change.
  return currentLiveSession(session);
}
function emptyBody(req: Request) {
  if (req.body !== undefined && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body as Record<string, unknown>).length)) throw new ValidationError('The document identity belongs in the path; do not supply titles, URLs or actors');
}
workDocumentsRouter.get('/documents/:documentId', asyncHandler(async (req, res) => {
  const session = await authority(req.session), documentId = id(req.params.documentId);
  const doc = await getDocumentRecord(documentId);
  await authority(session);
  if (!doc) throw new AppError(404, 'Document record not found');
  res.set('Cache-Control', 'no-store').json({ ...doc, href: documentRecordHref(doc.id) });
}));
workDocumentsRouter.get('/work-items/:id/documents', asyncHandler(async (req, res) => {
  const session = await authority(req.session), workItemId = id(req.params.id);
  if (!await getWorkItem(workItemId)) throw new AppError(404, 'Work item not found');
  const documents = await listWorkDocuments(workItemId);
  await authority(session);
  res.set('Cache-Control', 'no-store').json({ workItemId, documents });
}));
workDocumentsRouter.get('/work-items/:id/documents/candidates', asyncHandler(async (req, res) => {
  const session = await authority(req.session), workItemId = id(req.params.id);
  const query = req.query.q;
  if (query !== undefined && (typeof query !== 'string' || query.length > 200)) throw new ValidationError('Search text must be at most 200 characters');
  if (!await getWorkItem(workItemId)) throw new AppError(404, 'Work item not found');
  const documents = await searchDocumentRecords(typeof query === 'string' ? query.trim() : '');
  await authority(session);
  res.set('Cache-Control', 'no-store').json({ workItemId, documents });
}));
workDocumentsRouter.put('/work-items/:id/documents/:documentId', asyncHandler(async (req, res) => {
  emptyBody(req);
  let session = await authority(req.session, true);
  const workItemId = id(req.params.id), documentId = id(req.params.documentId);
  const [work, doc] = await Promise.all([getWorkItem(workItemId), getDocumentRecord(documentId)]);
  if (!work || !doc) throw new AppError(404, 'Work item or document record not found');
  session = await authority(session, true);
  const result = await linkWorkDocument(workItemId, documentId, session.sub);
  await authority(session, true);
  if (result.created) void notifyWorkGraphChanged(work.projectId, 'work-document');
  res.status(result.created ? 201 : 200).json({ workItemId, documentId, ...result });
}));
workDocumentsRouter.delete('/work-items/:id/documents/:documentId', asyncHandler(async (req, res) => {
  emptyBody(req);
  const session = await authority(req.session, true), workItemId = id(req.params.id), documentId = id(req.params.documentId);
  if (!await getWorkItem(workItemId)) throw new AppError(404, 'Work item not found');
  await authority(session, true);
  const removed = await unlinkWorkDocument(workItemId, documentId);
  await authority(session, true);
  if (removed) void getWorkItem(workItemId).then(item => item && notifyWorkGraphChanged(item.projectId, 'work-document')).catch(() => undefined);
  res.json({ workItemId, documentId, removed });
}));

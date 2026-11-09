import { Router, type Request } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { currentLiveSession } from '../lib/live-principal.js';
import { isAllowed } from '../lib/authz.js';
import { requireInitiativeScope, stewardsInitiative } from '../lib/initiative-scope.js';
import { getWorkItem } from '../providers/work-items.js';
import { getProject } from '../providers/projects.js';
import { notifyWorkGraphChanged } from '../lib/work-graph/live.js';
import {
  WORKSPACE_MARKDOWN_MAX, WORKSPACE_SCENE_MAX, WORKSPACE_TITLE_MAX, createWorkspaceDocument, documentRecordHref, getDocumentRecord, getWorkspaceDocument, linkWorkDocument,
  listWorkDocuments, listWorkspaceDocuments, searchDocumentRecords, unlinkWorkDocument, updateWorkspaceDocument, type WorkspaceDocumentKind,
} from '../providers/work-documents.js';
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
/**
 * G56: who writes a workspace page or whiteboard. The initiative's own people —
 * its owner, a contributor, or an org-wide role (lib/initiative-scope.ts
 * stewardsInitiative, the rule projects.ts holds a steward to) — with the Cedar
 * action every orgiq role that sees work holds (ViewWorkItems). Writing a page
 * spends nothing, so no agent-run grant: that stays on linking corpus records to
 * work items (authority(…, true) below) and on decks (they spend).
 */
const PAGE_WRITE_ACTION = 'ViewWorkItems';
async function pageAuthority(source: Session | undefined): Promise<Session> {
  const session = await authority(source);
  if (!await isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, PAGE_WRITE_ACTION)) {
    throw new AppError(403, 'Your role cannot write pages in initiatives');
  }
  return currentLiveSession(session);
}
/** The same rule as a yes/no for the portal, which only hides the New menu with it; the write routes decide. */
async function mayWritePages(session: Session, projectId: string): Promise<boolean> {
  try {
    return await isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, PAGE_WRITE_ACTION) && await stewardsInitiative(session, projectId);
  } catch { return false; }
}
function emptyBody(req: Request) {
  if (req.body !== undefined && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body as Record<string, unknown>).length)) throw new ValidationError('The document identity belongs in the path; do not supply titles, URLs or actors');
}
/** Every workspace page answers in the document-record shape the portal's one reader checks, plus its body and provenance. */
const workspaceRecord = (page: Awaited<ReturnType<typeof getWorkspaceDocument>> & object) => ({ ...page, source: 'workspace', sourceUri: null, ingestedAt: page.createdAt });
/** A workspace page's writable fields: a title up to 200 characters, markdown up to 200k, a whiteboard scene up to 2 MB. Anything else is refused. */
function workspaceFields(req: Request, { create }: { create: boolean }): { title?: string; markdown?: string; scene?: string; kind: WorkspaceDocumentKind; workItemId: string | null } {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('A document body is required');
  const allowed = create ? ['title', 'markdown', 'kind', 'workItemId'] : ['title', 'markdown', 'scene'];
  if (Object.keys(body as Record<string, unknown>).some(key => !allowed.includes(key))) throw new ValidationError(`Only ${allowed.join(', ')} may be set`);
  const { title, markdown, scene, kind, workItemId } = body as Record<string, unknown>;
  if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > WORKSPACE_TITLE_MAX)) throw new ValidationError(`A title is 1–${WORKSPACE_TITLE_MAX} characters`);
  if (markdown !== undefined && (typeof markdown !== 'string' || markdown.length > WORKSPACE_MARKDOWN_MAX)) throw new ValidationError('Markdown is a string up to 200k characters');
  if (scene !== undefined && (typeof scene !== 'string' || scene.length > WORKSPACE_SCENE_MAX || !/^[A-Za-z0-9+/=]*$/.test(scene))) throw new ValidationError('A scene is a base64 string up to 2 MB');
  if (create && title === undefined) throw new ValidationError('A title is required');
  if (kind !== undefined && kind !== 'page' && kind !== 'whiteboard') throw new ValidationError('kind is page or whiteboard');
  if (workItemId !== undefined && workItemId !== null) id(workItemId);
  if (!create && title === undefined && markdown === undefined && scene === undefined) throw new ValidationError('Nothing to change');
  return { ...(title !== undefined ? { title: title.trim() } : {}), ...(markdown !== undefined ? { markdown } : {}), ...(scene !== undefined ? { scene } : {}),
    kind: kind === 'whiteboard' ? 'whiteboard' : 'page', workItemId: typeof workItemId === 'string' ? workItemId : null };
}
workDocumentsRouter.get('/documents/:documentId', asyncHandler(async (req, res) => {
  const session = await authority(req.session), documentId = id(req.params.documentId);
  // A workspace page answers with its body and provenance; a corpus record with its ingest metadata.
  const [doc, page] = await Promise.all([getDocumentRecord(documentId), getWorkspaceDocument(documentId)]);
  await authority(session);
  if (page) {
    // The page's place, for the portal's trail: its initiative by name.
    const [project, canWrite] = await Promise.all([getProject(page.projectId), mayWritePages(session, page.projectId)]);
    res.set('Cache-Control', 'no-store').json({ ...workspaceRecord(page), projectName: project?.name ?? null, canWrite }); return;
  }
  if (!doc) throw new AppError(404, 'Document record not found');
  res.set('Cache-Control', 'no-store').json({ ...doc, href: documentRecordHref(doc.id) });
}));
workDocumentsRouter.put('/documents/:documentId', asyncHandler(async (req, res) => {
  const fields = workspaceFields(req, { create: false });
  let session = await pageAuthority(req.session);
  const documentId = id(req.params.documentId);
  const page = await getWorkspaceDocument(documentId);
  if (!page) throw new AppError(404, 'Workspace document not found');
  if (!await requireInitiativeScope(req, res, page.projectId, { action: 'edit documents' })) return;
  session = await pageAuthority(session);
  const updated = await updateWorkspaceDocument(documentId, { ...(fields.title !== undefined ? { title: fields.title } : {}), ...(fields.markdown !== undefined ? { markdown: fields.markdown } : {}),
    ...(fields.scene !== undefined ? { scene: fields.scene } : {}) });
  await pageAuthority(session);
  if (!updated) throw new AppError(404, 'Workspace document is no longer available');
  void notifyWorkGraphChanged(page.projectId, 'work-document');
  res.set('Cache-Control', 'no-store').json({ document: workspaceRecord(updated) });
}));
workDocumentsRouter.get('/projects/:projectId/workspace-documents', asyncHandler(async (req, res) => {
  const session = await authority(req.session), projectId = id(req.params.projectId);
  if (!await getProject(projectId)) throw new AppError(404, 'Initiative not found');
  const [documents, canWrite] = await Promise.all([listWorkspaceDocuments(projectId).then(rows => rows.map(workspaceRecord)), mayWritePages(session, projectId)]);
  await authority(session);
  // canWrite (G56): whether this caller may write pages and whiteboards here; the Docs tab hides New › Document / Whiteboard without it.
  res.set('Cache-Control', 'no-store').json({ projectId, documents, canWrite });
}));
workDocumentsRouter.post('/projects/:projectId/workspace-documents', asyncHandler(async (req, res) => {
  const fields = workspaceFields(req, { create: true });
  let session = await pageAuthority(req.session);
  const projectId = id(req.params.projectId);
  if (!await getProject(projectId)) throw new AppError(404, 'Initiative not found');
  if (fields.workItemId) {
    const work = await getWorkItem(fields.workItemId);
    if (!work || work.projectId !== projectId) throw new AppError(404, 'Work item not found on this initiative');
  }
  // Writing a page into an initiative is its own people's call (G56: owner, contributor or an org-wide role).
  if (!await requireInitiativeScope(req, res, projectId, { action: 'create documents' })) return;
  session = await pageAuthority(session);
  const document = await createWorkspaceDocument({ projectId, workItemId: fields.workItemId, title: fields.title!, kind: fields.kind, markdown: fields.markdown ?? '' }, session.sub);
  await pageAuthority(session);
  void notifyWorkGraphChanged(projectId, 'work-document');
  res.status(201).set('Cache-Control', 'no-store').json({ projectId, document: workspaceRecord(document) });
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
  // Linking a document to an item is the item's initiative's stewards' call (DE-44 row 23).
  if (!await requireInitiativeScope(req, res, work.projectId, { action: 'link documents' })) return;
  session = await authority(session, true);
  const result = await linkWorkDocument(workItemId, documentId, session.sub);
  await authority(session, true);
  if (result.created) void notifyWorkGraphChanged(work.projectId, 'work-document');
  res.status(result.created ? 201 : 200).json({ workItemId, documentId, ...result });
}));
workDocumentsRouter.delete('/work-items/:id/documents/:documentId', asyncHandler(async (req, res) => {
  emptyBody(req);
  const session = await authority(req.session, true), workItemId = id(req.params.id), documentId = id(req.params.documentId);
  const work = await getWorkItem(workItemId);
  if (!work) throw new AppError(404, 'Work item not found');
  if (!await requireInitiativeScope(req, res, work.projectId, { action: 'unlink documents' })) return;
  await authority(session, true);
  const removed = await unlinkWorkDocument(workItemId, documentId);
  await authority(session, true);
  if (removed) void notifyWorkGraphChanged(work.projectId, 'work-document');
  res.json({ workItemId, documentId, removed });
}));

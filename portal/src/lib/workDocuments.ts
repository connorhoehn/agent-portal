import { sendJson } from './writeJson.ts';
export interface DocumentRecord { id: string; title: string | null; source: string | null; sourceUri: string | null; ingestedAt: string | null }
export interface WorkDocument extends DocumentRecord { linkedBy: string; linkedAt: string }
export const documentRecordHref = (id: string) => `/iq/documents/${encodeURIComponent(id)}`;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,256}$/.test(value);
export function documentSourceHref(value: string | null): string | null {
  if (!value || /[\x00-\x20\\]/.test(value)) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function record(value: unknown): DocumentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid document record');
  const row = value as Record<string, unknown>;
  if (!validId(row.id) || ['title', 'source', 'sourceUri', 'ingestedAt'].some(key => row[key] !== null && typeof row[key] !== 'string')) {
    throw new Error('Invalid document record');
  }
  return { id: row.id, title: row.title as string | null, source: row.source as string | null,
    sourceUri: row.sourceUri as string | null, ingestedAt: row.ingestedAt as string | null };
}
export function readDocumentRecord(value: unknown, id: string): DocumentRecord {
  const doc = record(value); if (doc.id !== id) throw new Error('Document response changed identity'); return doc;
}
export function readWorkDocuments(value: unknown, workItemId: string): DocumentRecord[] {
  const body = value as { workItemId?: unknown; documents?: unknown } | null;
  if (!body || body.workItemId !== workItemId || !Array.isArray(body.documents)) throw new Error('Document response changed work item');
  return body.documents.map(record);
}
export async function changeWorkDocument(workItemId: string, documentId: string, method: 'PUT' | 'DELETE') {
  if (!validId(workItemId) || !validId(documentId)) throw new Error('Invalid work or document identity');
  const result = await sendJson<{ workItemId: string; documentId: string; created?: boolean; removed?: boolean }>(
    `/api/graph/work-items/${encodeURIComponent(workItemId)}/documents/${encodeURIComponent(documentId)}`, method);
  if (result.workItemId !== workItemId || result.documentId !== documentId
    || typeof (method === 'PUT' ? result.created : result.removed) !== 'boolean') throw new Error('Document association was not confirmed');
  return result;
}

// ─── Workspace documents (2026-11-02) ────────────────────────────────────────
// Pages written inside an initiative: the Docs tab's "New › Document".
export interface WorkspaceDocument extends DocumentRecord {
  projectId: string; workItemId: string | null; kind: 'page' | 'whiteboard'; markdown: string; createdBy: string; createdAt: string; updatedAt: string; href: string;
  /** A whiteboard's Excalidraw scene: a base64 Yjs update; empty for a page or a blank board. */
  scene: string;
  /** The initiative's name, on a single page read. */
  projectName?: string | null;
}
export function readWorkspaceDocument(value: unknown): WorkspaceDocument {
  const base = record(value);
  const row = value as Record<string, unknown>;
  if (typeof row.projectId !== 'string' || (row.workItemId !== null && typeof row.workItemId !== 'string') || typeof row.markdown !== 'string' || typeof row.scene !== 'string'
    || (row.kind !== 'page' && row.kind !== 'whiteboard') || typeof row.createdBy !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string'
    || row.href !== documentRecordHref(base.id) || (row.projectName !== undefined && row.projectName !== null && typeof row.projectName !== 'string')) throw new Error('Invalid workspace document');
  return { ...base, projectId: row.projectId, workItemId: row.workItemId as string | null, kind: row.kind, markdown: row.markdown, scene: row.scene,
    createdBy: row.createdBy, createdAt: row.createdAt, updatedAt: row.updatedAt, href: row.href, ...(typeof row.projectName === 'string' ? { projectName: row.projectName } : {}) };
}
/** True when a `/api/graph/documents/:id` answer is a workspace page rather than a corpus record. */
export const isWorkspaceDocument = (value: unknown): boolean => !!value && typeof value === 'object' && (value as Record<string, unknown>).source === 'workspace';
export function readWorkspaceDocuments(value: unknown, projectId: string): WorkspaceDocument[] {
  const body = value as { projectId?: unknown; documents?: unknown } | null;
  if (!body || body.projectId !== projectId || !Array.isArray(body.documents)) throw new Error('Document response changed initiative');
  return body.documents.map(readWorkspaceDocument);
}
export async function createWorkspaceDocument(projectId: string, input: { title: string; workItemId?: string | null; markdown?: string; kind?: 'page' | 'whiteboard' }): Promise<WorkspaceDocument> {
  if (!validId(projectId)) throw new Error('Invalid initiative identity');
  const result = await sendJson<{ projectId: string; document: unknown }>(`/api/graph/projects/${encodeURIComponent(projectId)}/workspace-documents`, 'POST',
    { title: input.title, ...(input.workItemId ? { workItemId: input.workItemId } : {}), ...(input.markdown !== undefined ? { markdown: input.markdown } : {}), ...(input.kind ? { kind: input.kind } : {}) });
  if (result.projectId !== projectId) throw new Error('Document response changed initiative');
  return readWorkspaceDocument(result.document);
}
export async function updateWorkspaceDocument(id: string, patch: { title?: string; markdown?: string; scene?: string }): Promise<WorkspaceDocument> {
  if (!validId(id)) throw new Error('Invalid document identity');
  const result = await sendJson<{ document: unknown }>(`/api/graph/documents/${encodeURIComponent(id)}`, 'PUT', patch);
  const doc = readWorkspaceDocument(result.document);
  if (doc.id !== id) throw new Error('Document response changed identity');
  return doc;
}

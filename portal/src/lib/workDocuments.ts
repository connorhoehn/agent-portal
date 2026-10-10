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

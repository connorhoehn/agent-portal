import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { clock, defineFixture } from '../mock/core/index.js';
import { kbDocumentRows } from '../mock/knowledge-base.js';
import { AppError } from '../lib/async-handler.js';
import { exec } from './aurora.js';
import type { IngestedDoc } from './knowledge-base.js';

export interface WorkDocumentLink { workItemId: string; documentId: string; linkedBy: string; linkedAt: string }
export interface WorkDocument extends IngestedDoc { linkedBy: string; linkedAt: string; href: string }
// Associations start empty, like a newly migrated database. The user selects
// actual corpus records; no architecture relationship is inferred from a name.
export const workDocumentLinks = defineFixture<WorkDocumentLink>({ key: 'work-document-links',
  scenarios: { default: () => [], empty: () => [] } });
const str = (name: string, value: string) => ({ name, value: { stringValue: value } });
export const documentRecordHref = (id: string) => `/iq/documents/${encodeURIComponent(id)}`;
const nullable = (value: unknown) => value == null ? null : String(value);
function documentRow(row: Record<string, unknown>): IngestedDoc {
  return { id: String(row.id), title: nullable(row.title), source: nullable(row.source),
    sourceUri: nullable(row.source_uri), ingestedAt: nullable(row.ingested_at) };
}
async function relations(sql: string, params: ReturnType<typeof str>[]) {
  try { return await exec(sql, params); }
  catch (error) {
    if (/relation ["']?(?:public\.)?work_item_documents["']? does not exist/i.test(String((error as Error).message))) {
      throw new AppError(503, 'Work document associations require the work_item_documents_schema.sql migration');
    }
    throw error;
  }
}
/** Mirrors the tenant-open corpus metadata read; does not grant source access. */
export async function getDocumentRecord(id: string): Promise<IngestedDoc | null> {
  if (config.mock.aurora) {
    const doc = kbDocumentRows.rows().find(row => row.id === id);
    return doc ? structuredClone(doc) : null;
  }
  const rows = await exec(`SELECT id, title, source, source_uri, ingested_at::text
    FROM documents WHERE id = :id`, [str('id', id)]);
  return rows[0] ? documentRow(rows[0]) : null;
}
export async function searchDocumentRecords(query: string): Promise<IngestedDoc[]> {
  if (config.mock.aurora) return kbDocumentRows.rows().filter(doc => `${doc.title ?? ''} ${doc.id}`.toLowerCase()
    .includes(query.toLowerCase())).slice(0, 25).map(doc => structuredClone(doc));
  const literal = query.replace(/[\\%_]/g, value => `\\${value}`);
  const rows = await exec(`SELECT id, title, source, source_uri, ingested_at::text FROM documents
    WHERE COALESCE(title, '') ILIKE :query OR id ILIKE :query
    ORDER BY ingested_at DESC NULLS LAST, id LIMIT 25`, [str('query', `%${literal}%`)]);
  return rows.map(documentRow);
}
export async function listWorkDocuments(workItemId: string): Promise<WorkDocument[]> {
  if (config.mock.aurora) {
    const docs = new Map(kbDocumentRows.rows().map(doc => [doc.id, doc]));
    return workDocumentLinks.rows().filter(row => row.workItemId === workItemId && docs.has(row.documentId))
      .sort((a, b) => a.linkedAt.localeCompare(b.linkedAt) || a.documentId.localeCompare(b.documentId))
      .map(row => ({ ...structuredClone(docs.get(row.documentId)!), linkedBy: row.linkedBy,
        linkedAt: row.linkedAt, href: documentRecordHref(row.documentId) }));
  }
  const rows = await relations(`SELECT d.id, d.title, d.source, d.source_uri, d.ingested_at::text,
    l.linked_by, l.linked_at::text FROM work_item_documents l
    JOIN documents d ON d.id = l.document_id WHERE l.work_item_id = :work
    ORDER BY l.linked_at, l.document_id`, [str('work', workItemId)]);
  return rows.map(row => ({ ...documentRow(row), linkedBy: String(row.linked_by), linkedAt: String(row.linked_at),
    href: documentRecordHref(String(row.id)) }));
}
export async function linkWorkDocument(workItemId: string, documentId: string, actor: string): Promise<{ created: boolean }> {
  if (config.mock.aurora) {
    if (!kbDocumentRows.rows().some(doc => doc.id === documentId)) throw new AppError(404, 'Document record not found');
    if (workDocumentLinks.rows().some(row => row.workItemId === workItemId && row.documentId === documentId)) return { created: false };
    workDocumentLinks.rows().push({ workItemId, documentId, linkedBy: actor, linkedAt: clock.nowIso() });
    return { created: true };
  }
  const inserted = await relations(`INSERT INTO work_item_documents (work_item_id, document_id, linked_by)
    SELECT w.id, d.id, :actor FROM work_items w CROSS JOIN documents d
    WHERE w.id = :work AND d.id = :document
    ON CONFLICT (work_item_id, document_id) DO NOTHING RETURNING document_id`,
  [str('work', workItemId), str('document', documentId), str('actor', actor)]);
  if (inserted.length) return { created: true };
  const present = await relations(`SELECT document_id FROM work_item_documents
    WHERE work_item_id = :work AND document_id = :document`, [str('work', workItemId), str('document', documentId)]);
  if (!present.length) throw new AppError(404, 'Work item or document record is no longer available');
  return { created: false };
}
export async function unlinkWorkDocument(workItemId: string, documentId: string): Promise<boolean> {
  if (config.mock.aurora) {
    const rows = workDocumentLinks.rows(); const index = rows.findIndex(row => row.workItemId === workItemId && row.documentId === documentId);
    if (index < 0) return false; rows.splice(index, 1); return true;
  }
  const rows = await relations(`DELETE FROM work_item_documents WHERE work_item_id = :work
    AND document_id = :document RETURNING document_id`, [str('work', workItemId), str('document', documentId)]);
  return rows.length > 0;
}

// ─── Workspace documents ─────────────────────────────────────────────────────
// Pages written INSIDE an initiative (schema/work_documents_schema.sql): the
// Docs tab's "New › Document" and the Discussion's /doc "Save as document".
// Distinct from the corpus records above, which are only ever linked.

export type WorkspaceDocumentKind = 'page' | 'whiteboard';
export interface WorkspaceDocumentRow {
  id: string; projectId: string; workItemId: string | null; title: string; kind: WorkspaceDocumentKind;
  markdown: string; createdBy: string; createdAt: string; updatedAt: string;
}
export interface WorkspaceDocument extends WorkspaceDocumentRow { href: string }
export const WORKSPACE_TITLE_MAX = 200;
export const WORKSPACE_MARKDOWN_MAX = 200_000;
// Starts empty, like a newly migrated database; reset undoes every create.
export const workspaceDocuments = defineFixture<WorkspaceDocumentRow>({ key: 'work-documents',
  scenarios: { default: () => [], empty: () => [] } });
const withHref = (row: WorkspaceDocumentRow): WorkspaceDocument => ({ ...structuredClone(row), href: documentRecordHref(row.id) });
function workspaceRow(row: Record<string, unknown>): WorkspaceDocumentRow {
  return { id: String(row.id), projectId: String(row.project_id), workItemId: nullable(row.work_item_id), title: String(row.title),
    kind: row.kind === 'whiteboard' ? 'whiteboard' : 'page', markdown: String(row.markdown ?? ''), createdBy: String(row.created_by),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
async function workspaceSql(sql: string, params: ReturnType<typeof str>[]) {
  try { return await exec(sql, params); }
  catch (error) {
    if (/relation ["']?(?:public\.)?work_documents["']? does not exist/i.test(String((error as Error).message))) {
      throw new AppError(503, 'Workspace documents require the work_documents_schema.sql migration');
    }
    throw error;
  }
}
const WORKSPACE_COLUMNS = 'id, project_id, work_item_id, title, kind, markdown, created_by, created_at::text, updated_at::text';
export async function getWorkspaceDocument(id: string): Promise<WorkspaceDocument | null> {
  if (config.mock.aurora) { const row = workspaceDocuments.rows().find(doc => doc.id === id); return row ? withHref(row) : null; }
  const rows = await workspaceSql(`SELECT ${WORKSPACE_COLUMNS} FROM work_documents WHERE id = :id`, [str('id', id)]);
  return rows[0] ? withHref(workspaceRow(rows[0])) : null;
}
export async function listWorkspaceDocuments(projectId: string): Promise<WorkspaceDocument[]> {
  if (config.mock.aurora) {
    return workspaceDocuments.rows().filter(doc => doc.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(withHref);
  }
  const rows = await workspaceSql(`SELECT ${WORKSPACE_COLUMNS} FROM work_documents WHERE project_id = :project
    ORDER BY updated_at DESC, id`, [str('project', projectId)]);
  return rows.map(row => withHref(workspaceRow(row)));
}
export async function createWorkspaceDocument(input: { projectId: string; workItemId: string | null; title: string; kind: WorkspaceDocumentKind; markdown: string },
  actor: string): Promise<WorkspaceDocument> {
  const id = `wdoc-${randomUUID()}`;
  if (config.mock.aurora) {
    const now = clock.nowIso();
    const row: WorkspaceDocumentRow = { id, projectId: input.projectId, workItemId: input.workItemId, title: input.title, kind: input.kind,
      markdown: input.markdown, createdBy: actor, createdAt: now, updatedAt: now };
    workspaceDocuments.rows().push(row);
    return withHref(row);
  }
  const rows = await workspaceSql(`INSERT INTO work_documents (id, project_id, work_item_id, title, kind, markdown, created_by)
    SELECT :id, p.id, w.id, :title, :kind, :markdown, :actor FROM projects p
    LEFT JOIN work_items w ON w.id = :work AND w.project_id = p.id WHERE p.id = :project
    RETURNING ${WORKSPACE_COLUMNS}`,
  [str('id', id), str('project', input.projectId), str('work', input.workItemId ?? ''), str('title', input.title), str('kind', input.kind),
    str('markdown', input.markdown), str('actor', actor)]);
  if (!rows[0]) throw new AppError(404, 'Initiative not found');
  return withHref(workspaceRow(rows[0]));
}
export async function updateWorkspaceDocument(id: string, patch: { title?: string; markdown?: string }): Promise<WorkspaceDocument | null> {
  if (config.mock.aurora) {
    const row = workspaceDocuments.rows().find(doc => doc.id === id);
    if (!row) return null;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.markdown !== undefined) row.markdown = patch.markdown;
    row.updatedAt = clock.nowIso();
    return withHref(row);
  }
  const rows = await workspaceSql(`UPDATE work_documents SET title = COALESCE(:title, title), markdown = COALESCE(:markdown, markdown), updated_at = NOW()
    WHERE id = :id RETURNING ${WORKSPACE_COLUMNS}`,
  [str('id', id), ...(patch.title !== undefined ? [str('title', patch.title)] : [{ name: 'title', value: { isNull: true } }]),
    ...(patch.markdown !== undefined ? [str('markdown', patch.markdown)] : [{ name: 'markdown', value: { isNull: true } }])] as ReturnType<typeof str>[]);
  return rows[0] ? withHref(workspaceRow(rows[0])) : null;
}

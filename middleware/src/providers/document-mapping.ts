import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { exec, type TxExec } from './aurora.js';
import { defineFixture } from '../mock/core/fixture.js';
import { knowledgeDocsFixture } from '../mock/assessment.js';

export interface DocumentMapping {
  tenant_id: string;
  source_namespace: string;
  source_id: string;
  document_id: string;
  source_revision: string;
  schema_version: number;
  migration_state: 'pending' | 'ready';
  owner_sub: string | null;
  published_revision: string | null;
}

export const documentMappingsFixture = defineFixture<DocumentMapping>({
  key: 'assessment-document-mappings', scenarios: {
    default: () => knowledgeDocsFixture.rows('default').map(doc => ({
      tenant_id: 'assessment', source_namespace: 'knowledge', source_id: doc.id,
      document_id: mockDocumentId(doc.id), source_revision: documentSourceRevision(doc.markdown),
      schema_version: 2, migration_state: 'pending',
      owner_sub: process.env['DOCUMENT_SOURCE_OWNER_SUB']?.trim() || null,
      published_revision: null,
    })),
    empty: () => [],
  },
});
const str = (name: string, value: string) => ({ name, value: { stringValue: value } });

// Mock server restarts retain the same channel identity in the durable gateway.
// The registered rows still reset migration state with the mock control plane.
function mockDocumentId(sourceId: string): string {
  const hash = createHash('sha256').update(`assessment:knowledge:${sourceId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function documentSourceRevision(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/** Concurrent first opens converge on one UUID; retries never rename channels. */
export async function ensureDocumentMapping(sourceId: string, revision: string, ownerSub?: string, transaction?: TxExec): Promise<DocumentMapping> {
  const scope = { tenant_id: 'assessment', source_namespace: 'knowledge', source_id: sourceId };
  const owner = ownerSub?.trim() || process.env['DOCUMENT_SOURCE_OWNER_SUB']?.trim() || null;
  if (owner && owner.length > 256) throw new Error('Invalid document owner');
  if (config.mock.aurora) {
    const existing = documentMappingsFixture.rows().find(row => row.tenant_id === scope.tenant_id
      && row.source_namespace === scope.source_namespace && row.source_id === sourceId);
    if (existing) return { ...existing };
    const row: DocumentMapping = { ...scope, document_id: mockDocumentId(sourceId), source_revision: revision,
      schema_version: 2, migration_state: 'pending', owner_sub: owner, published_revision: null };
    documentMappingsFixture.rows().push(row);
    return { ...row };
  }
  const rows = await (transaction ?? exec)(`INSERT INTO assessment_document_mappings
    (tenant_id, source_namespace, source_id, document_id, source_revision, schema_version, migration_state, owner_sub)
    VALUES (:tenant, :namespace, :source, CAST(:document AS uuid), :revision, 2, 'pending', :owner)
    ON CONFLICT (tenant_id, source_namespace, source_id) DO UPDATE
      SET source_id = EXCLUDED.source_id
    RETURNING tenant_id, source_namespace, source_id, document_id::text, source_revision, schema_version, migration_state, owner_sub, published_revision`,
  [str('tenant', scope.tenant_id), str('namespace', scope.source_namespace), str('source', sourceId),
    str('document', randomUUID()), str('revision', revision),
    { name: 'owner', value: owner ? { stringValue: owner } : { isNull: true } }]);
  if (!rows[0]) throw new Error('document mapping was not persisted');
  return rows[0] as DocumentMapping;
}

/** A remote publication advances the comparison base without changing import identity. */
export async function advanceDocumentSourceRevision(documentId: string, expected: string, next: string, transaction?: TxExec): Promise<boolean> {
  if (config.mock.aurora) {
    const row = documentMappingsFixture.rows().find(value => value.document_id === documentId
      && (value.published_revision ?? value.source_revision) === expected);
    if (!row) return false;
    row.published_revision = next;
    return true;
  }
  const rows = await (transaction ?? exec)(`UPDATE assessment_document_mappings SET published_revision = :next
    WHERE tenant_id = 'assessment' AND document_id = CAST(:document AS uuid)
      AND COALESCE(published_revision, source_revision) = :expected RETURNING document_id`,
  [str('next', next), str('document', documentId), str('expected', expected)]);
  return rows.length === 1;
}

/** Only the seed coordinator may acknowledge the matching durable revision. */
export async function markDocumentMappingReady(documentId: string, revision: string): Promise<boolean> {
  if (config.mock.aurora) {
    const row = documentMappingsFixture.rows().find(value => value.document_id === documentId && value.source_revision === revision);
    if (!row) return false;
    row.migration_state = 'ready';
    return true;
  }
  const rows = await exec(`UPDATE assessment_document_mappings SET migration_state = 'ready'
    WHERE tenant_id = 'assessment' AND document_id = CAST(:document AS uuid) AND source_revision = :revision
    RETURNING document_id`, [str('document', documentId), str('revision', revision)]);
  return rows.length === 1;
}

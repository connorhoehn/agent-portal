import { config } from '../config.js';
import { AppError } from '../lib/async-handler.js';
import { exec } from './aurora.js';
import { documentMappingsFixture } from './document-mapping.js';

/** A migrated document has one binary authority; old Markdown endpoints may
 * not change its import baseline or advertise a restore that the canvas ignores. */
export async function assertLegacyDocumentWritable(sourceId: string): Promise<void> {
  const mappings = config.mock.aurora
    ? documentMappingsFixture.rows().filter(row => row.source_id === sourceId)
    : await exec(`SELECT migration_state FROM assessment_document_mappings
        WHERE tenant_id = 'assessment' AND source_namespace = 'knowledge' AND source_id = :source`,
      [{ name: 'source', value: { stringValue: sourceId } }]);
  if (mappings.some(row => row.migration_state === 'ready'
    || (row.migration_state === 'pending' && Boolean(process.env['DOCUMENT_GATEWAY_PUBLIC_URL'])))) {
    throw new AppError(409, 'This document uses the collaborative editor. Use its binary version history to restore content.');
  }
}

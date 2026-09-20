import WebSocket from 'ws';
import type { Session } from '../lib/session.js';
import { isAllowed } from '../lib/authz.js';
import { getKnowledgeDoc } from './assessment.js';
import { documentWorkflowAccess } from './document-canvas.js';
import { DocumentWorkflowError, performDocumentWorkflow } from './document-workflows.js';

export type DocumentVersionChange = { action: 'save'; name?: string } | { action: 'restore'; timestamp: number };

/** Named versions and restore use the canonical gateway snapshot operations.
 * A restore never converts Markdown or sends a privileged grant to the browser. */
export async function changeDocumentVersion(sourceId: string, session: Session, change: DocumentVersionChange) {
  if (!await isAllowed(session, 'ManageKnowledge')) throw new DocumentWorkflowError(403, 'Document editing permission required');
  const source = await getKnowledgeDoc(sourceId);
  if (!source) throw new DocumentWorkflowError(404, 'Document not found');
  const access = await documentWorkflowAccess(source, session);
  if (!access.canEdit) throw new DocumentWorkflowError(403, 'Document is read-only');
  if (change.action === 'restore' && !access.canManageWorkflow) throw new DocumentWorkflowError(403, 'Document management permission required');
  const policy = await performDocumentWorkflow(sourceId, session, { kind: 'write-policy', method: 'GET' });
  if (policy.status !== 200) throw new DocumentWorkflowError(policy.status, 'Document write policy is unavailable');
  if (policy.body.documentId !== access.documentId || policy.body.canWrite !== true) throw new DocumentWorkflowError(409, 'Document content is locked');
  if (change.action === 'restore') {
    const workflow = await performDocumentWorkflow(sourceId, session, { kind: 'lifecycle', method: 'GET' });
    const lifecycle = workflow.body.lifecycle as { ownerId?: unknown } | undefined;
    if (workflow.status !== 200) throw new DocumentWorkflowError(workflow.status, 'Document ownership is unavailable');
    if (workflow.body.documentId !== access.documentId || lifecycle?.ownerId !== session.sub) {
      throw new DocumentWorkflowError(403, 'Only the document owner may restore a version');
    }
  }
  const raw = process.env['DOCUMENT_GATEWAY_INTERNAL_URL'] || access.gatewayUrl;
  const url = new URL(raw);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new DocumentWorkflowError(503, 'Invalid document transport configuration');
  return exchangeVersion(raw, access.token, access.documentId, change);
}

export function exchangeVersion(url: string, token: string, documentId: string, change: DocumentVersionChange): Promise<{ timestamp: number; name?: string; restored?: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ['document-grant-v1', token], { handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 });
    const channel = `doc:${documentId}`;
    let finished = false;
    const timer = setTimeout(() => finish(new DocumentWorkflowError(503, 'Document version acknowledgement timed out')), 15000);
    function finish(error?: Error, value?: { timestamp: number; name?: string; restored?: boolean }) {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(value!);
    }
    let phase: 'subscribe' | 'change' = 'subscribe';
    socket.on('open', () => socket.send(JSON.stringify({ service: 'crdt', channel, action: 'subscribe' })));
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'error') { finish(new DocumentWorkflowError(403, 'Document version operation was refused')); return; }
        if (phase === 'subscribe' && message.type === 'crdt:snapshot' && message.channel === channel) {
          phase = 'change';
          socket.send(JSON.stringify({ service: 'crdt', channel, action: change.action === 'save' ? 'saveVersion' : 'restoreSnapshot',
            ...(change.action === 'save' ? { name: change.name?.trim() || 'Manual version' } : { timestamp: change.timestamp }) }));
          return;
        }
        const expected = change.action === 'save' ? 'versionSaved' : 'snapshotRestored';
        if (message.type !== 'crdt' || message.action !== expected || message.channel !== channel) return;
        const timestamp = Number(message.timestamp);
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0
          || (change.action === 'restore' && timestamp !== change.timestamp)) {
          finish(new DocumentWorkflowError(503, 'Invalid document version acknowledgement')); return;
        }
        finish(undefined, { timestamp, ...(change.action === 'restore' ? { restored: true } : typeof message.name === 'string' ? { name: message.name } : {}) });
      } catch { finish(new DocumentWorkflowError(503, 'Invalid document version response')); }
    });
    socket.on('error', () => finish(new DocumentWorkflowError(503, 'Document version transport unavailable')));
    socket.on('close', () => finish(new DocumentWorkflowError(503, 'Document transport closed before acknowledgement')));
  });
}

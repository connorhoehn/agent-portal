import { sourceMarkdownForCanvas } from './document-source-assets.js';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { createCanvasSeed, createDocumentGrant, type DocumentOperation } from '@connorhoehnslalom/realtime-modules/server';
import type { Session } from '../lib/session.js';
import { currentDocumentSessionEpoch, documentSessionId } from '../lib/document-session.js';
import { documentCanvasSchema } from '../lib/document-canvas-schema.js';
import { documentSourceRevision, ensureDocumentMapping, markDocumentMappingReady } from './document-mapping.js';
import { canvasSourceEditable } from './document-editability.js';

interface CanvasSource { id: string; title: string; classification: string; markdown: string; editable?: boolean; source_parent_id?: string | null }

function configuration() {
  const issuer = process.env['DOCUMENT_GRANT_ISSUER'];
  const privateKey = process.env['DOCUMENT_GRANT_PRIVATE_KEY'];
  const keyId = process.env['DOCUMENT_GRANT_KEY_ID'];
  const gatewayUrl = process.env['DOCUMENT_GATEWAY_PUBLIC_URL'];
  const internalUrl = process.env['DOCUMENT_GATEWAY_INTERNAL_URL'] || gatewayUrl;
  if (!issuer || !privateKey || !keyId || !gatewayUrl || !internalUrl) throw new Error('Document collaboration is not configured');
  for (const raw of [gatewayUrl, internalUrl]) {
    const url = new URL(raw);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid document gateway configuration');
    if (process.env['NODE_ENV'] === 'production' && raw === gatewayUrl && url.protocol !== 'wss:') throw new Error('Public document gateway requires TLS');
  }
  return { issuer, privateKey, keyId, gatewayUrl, internalUrl };
}

/** One narrowly scoped bootstrap connection; completion means durable storage acknowledged. */
export function seedCanvasOverGateway(url: string, token: string, documentId: string, sourceRevision: string, snapshot: string, title?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, ['document-grant-v1', token], { handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 });
    const requestId = randomUUID();
    const timer = setTimeout(() => finish(new Error('Document import timed out')), 15000);
    let finished = false;
    function finish(error?: Error) {
      if (finished) return;
      finished = true; clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve();
    }
    socket.on('open', () => socket.send(JSON.stringify({ service: 'crdt', action: 'seedDocument',
      channel: `doc:${documentId}`, sourceRevision, snapshot, title, type: 'assessment', requestId })));
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'crdt:seeded' && message.requestId === requestId
          && message.channel === `doc:${documentId}` && message.sourceRevision === sourceRevision) finish();
        else if (message.type === 'error') finish(new Error('Document import was rejected'));
      } catch { finish(new Error('Invalid document gateway response')); }
    });
    socket.on('error', () => finish(new Error('Document gateway unavailable')));
    socket.on('close', () => finish(new Error('Document gateway closed before import completed')));
  });
}

export interface DocumentCanvasAccess {
  documentId:string;sourceId:string;title:string;classification:string;canEdit:boolean;canManageWorkflow:boolean;
  sourceParentId?:string|null;gatewayUrl:string;token:string;expiresAt:number;sourceRevision:string;
}

export async function connectDocumentCanvas(source: CanvasSource, session: Session, canEdit: boolean, options: { workflowManage?: boolean } = {}):Promise<DocumentCanvasAccess> {
  const { isAllowed } = await import('../lib/authz.js');
  if (session.tenant !== 'assessment' || !await isAllowed(session, 'ViewAssessment')) throw new Error('Switch to an authorized assessment session before opening documents');
  const mayEdit = canEdit && canvasSourceEditable(source) && await isAllowed(session, 'ManageKnowledge');
  const settings = configuration();
  const sessionId = documentSessionId(session);
  const epoch = await currentDocumentSessionEpoch(session.sub, 'assessment', sessionId);
  if (epoch === null) throw new Error('Document session is no longer authorized');
  const mapping = await ensureDocumentMapping(source.id, documentSourceRevision(source.markdown));
  const issue = (operations: DocumentOperation[]) => createDocumentGrant({
    iss: settings.issuer, sub: session.sub, tenantId: 'assessment', documentId: mapping.document_id,
    operations, sessionId, sessionEpoch: epoch,
    ...(operations.length === 1 && operations[0] === 'seed' && mapping.owner_sub ? { seedOwnerSub: mapping.owner_sub } : {}),
  }, { privateKey: settings.privateKey, keyId: settings.keyId });
  if (mapping.migration_state === 'pending') {
    if (mapping.source_revision !== documentSourceRevision(source.markdown)) throw new Error('Source changed during document import; review migration before retrying');
    const markdown = source.id.startsWith('page:') ? sourceMarkdownForCanvas(source.id, source.markdown) : source.markdown;
    const seed = createCanvasSeed(markdown, { schema: documentCanvasSchema });
    await seedCanvasOverGateway(settings.internalUrl, issue(['seed']), mapping.document_id, mapping.source_revision, seed.snapshot, source.title);
    if (!await markDocumentMappingReady(mapping.document_id, mapping.source_revision)) throw new Error('Document import acknowledgement could not be recorded');
  }
  const operations: DocumentOperation[] = mayEdit ? ['read', 'comment', 'edit'] : ['read', 'comment'];
  let canManageWorkflow = false;
  if (mayEdit && mapping.owner_sub === session.sub) {
    const { isAllowed } = await import('../lib/authz.js');
    canManageWorkflow = await isAllowed(session, 'ManageKnowledge');
    if (options.workflowManage && canManageWorkflow) operations.push('manage');
  }
  return { documentId: mapping.document_id, sourceId: source.id, title: source.title, classification: source.classification,
    canEdit: mayEdit, canManageWorkflow, sourceParentId: source.source_parent_id ?? null, gatewayUrl: settings.gatewayUrl, token: issue(operations),
    expiresAt: Date.now() + 120_000, sourceRevision: mapping.published_revision ?? mapping.source_revision };
}

/** Server-side workflow delegation; ordinary browser sessions never gain manage. */
export async function documentWorkflowAccess(source: CanvasSource, session: Session) {
  const { isAllowed } = await import('../lib/authz.js');
  if (session.tenant !== 'assessment' || !await isAllowed(session, 'ViewAssessment')) throw new Error('Document workflow access denied');
  const canEdit = canvasSourceEditable(source) && await isAllowed(session, 'ManageKnowledge');
  return connectDocumentCanvas(source, session, canEdit, { workflowManage: true });
}

/** Derive an exchange projection from an explicitly acknowledged binary version.
 * Source publication may use this result; a browser-provided Markdown body may
 * never become the authority for an already migrated document.
 */
export async function readDocumentCanvasProjection(source: CanvasSource, session: Session): Promise<{
  markdown: string; sourceRevision: string; documentId: string; version: string;
}> {
  const { isAllowed } = await import('../lib/authz.js');
  if (session.tenant !== 'assessment' || source.id.startsWith('prompt:')
    || !(source.editable === true || source.classification === 'synced')
    || !await isAllowed(session, 'ManageKnowledge')) throw new Error('Document publication is not authorized');
  const grant = await connectDocumentCanvas(source, session, true);
  const channel = `doc:${grant.documentId}`;
  const result = await new Promise<{ snapshot: string; version: string }>((resolve, reject) => {
    const socket = new WebSocket(configuration().internalUrl, ['document-grant-v1', grant.token], { handshakeTimeout: 5000, maxPayload: 8 * 1024 * 1024 });
    let phase: 'subscribe' | 'save' | 'read' = 'subscribe';
    let version = '';
    let finished = false;
    const timer = setTimeout(() => finish(new Error('Document version could not be acknowledged')), 15000);
    function finish(error?: Error, snapshot?: string) {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.close();
      if (error || !snapshot) reject(error ?? new Error('Document version is empty'));
      else resolve({ snapshot, version });
    }
    const send = (action: string, data: object = {}) => socket.send(JSON.stringify({ service: 'crdt', action, channel, ...data }));
    socket.on('open', () => send('subscribe'));
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'error') { finish(new Error('Document version request was rejected')); return; }
        if (message.channel !== channel) return;
        if (phase === 'subscribe' && message.type === 'crdt:snapshot') {
          phase = 'save'; send('saveVersion', { name: 'Source publication candidate' });
        } else if (phase === 'save' && message.type === 'crdt' && message.action === 'versionSaved' && message.timestamp) {
          version = String(message.timestamp); phase = 'read'; send('getSnapshotAtVersion', { timestamp: message.timestamp });
        } else if (phase === 'read' && message.type === 'crdt' && message.action === 'snapshot'
          && String(message.timestamp) === version && typeof message.update === 'string') finish(undefined, message.update);
      } catch { finish(new Error('Invalid document version response')); }
    });
    socket.on('error', () => finish(new Error('Document gateway unavailable')));
    socket.on('close', () => finish(new Error('Document gateway closed before version acknowledgement')));
  });
  const { exportCanvasProjection } = await import('@connorhoehnslalom/realtime-modules/server');
  const projection = exportCanvasProjection(result.snapshot);
  return { markdown: projection.markdown, sourceRevision: grant.sourceRevision, documentId: grant.documentId, version: result.version };
}

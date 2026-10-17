jest.mock('@connorhoehn/realtime-modules/server', () => ({
  createCanvasSeed: jest.fn(() => ({ snapshot: 'Yml0cw==', unsupported: [] })),
  createDocumentGrant: jest.fn(() => 'signed-grant'),
  exportCanvasProjection: jest.fn(() => ({ markdown: '# Acknowledged binary' })),
}));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../../lib/document-canvas-schema.js', () => ({ documentCanvasSchema: {} }));
jest.mock('../../lib/document-session.js', () => ({ documentSessionId: () => 'session-ref', currentDocumentSessionEpoch: jest.fn(async () => 2) }));
jest.mock('../document-mapping.js', () => ({
  documentSourceRevision: () => 'source-revision',
  ensureDocumentMapping: jest.fn(async () => ({ document_id: '00000000-0000-4000-a000-000000000001', source_revision: 'source-revision', migration_state: 'pending' })),
  markDocumentMappingReady: jest.fn(async () => true),
}));

import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCanvasSeed, createDocumentGrant } from '@connorhoehn/realtime-modules/server';
import { connectDocumentCanvas, readDocumentCanvasProjection } from '../document-canvas.js';
import { ensureDocumentMapping, markDocumentMappingReady } from '../document-mapping.js';
import { currentDocumentSessionEpoch } from '../../lib/document-session.js';
import type { Session } from '../../lib/session.js';

const server = createServer();
const gateway = new WebSocketServer({ server });
const savedEnvironment = { ...process.env };
let rejectSeed = false;
let rejectVersion = false;
const actions: string[] = [];
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  Object.assign(process.env, { DOCUMENT_GRANT_ISSUER: 'test', DOCUMENT_GRANT_KEY_ID: 'test',
    DOCUMENT_GRANT_PRIVATE_KEY: 'test', DOCUMENT_GATEWAY_PUBLIC_URL: `ws://127.0.0.1:${address.port}` });
  gateway.on('connection', socket => socket.on('message', bytes => {
    const input = JSON.parse(bytes.toString());
    actions.push(input.action);
    if (input.action === 'subscribe') { socket.send(JSON.stringify({ type: 'crdt:snapshot', channel: input.channel, update: 'current' })); return; }
    if (input.action === 'saveVersion') {
      socket.send(JSON.stringify(rejectVersion ? { type: 'error' } : { type: 'crdt', action: 'versionSaved', channel: input.channel, timestamp: 1234 })); return;
    }
    if (input.action === 'getSnapshotAtVersion') {
      socket.send(JSON.stringify({ type: 'crdt', action: 'snapshot', channel: input.channel, timestamp: input.timestamp, update: 'persisted-binary' })); return;
    }
    socket.send(JSON.stringify(rejectSeed ? { type: 'error' } : {
      type: 'crdt:seeded', channel: input.channel, requestId: input.requestId, sourceRevision: input.sourceRevision,
    }));
  }));
});
beforeEach(() => { jest.clearAllMocks(); rejectSeed = false; rejectVersion = false; actions.length = 0; });
afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  for (const socket of gateway.clients) socket.terminate();
  await new Promise<void>(resolve => gateway.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});
const session: Session = { sub: 'alice', role: 'assessor', tenant: 'assessment', epoch: 2, iat: 1, grants: { assessment: ['assessor'] } };
const source = { id: 'page:100002', title: 'Rubric', classification: 'synced', markdown: '# Rubric' };

it('seeds trusted source under a separate seed-only credential before granting read access', async () => {
  const result = await connectDocumentCanvas(source, session, false);
  expect(createCanvasSeed).toHaveBeenCalledWith(source.markdown, { schema: {} });
  expect(jest.mocked(createDocumentGrant).mock.calls.map(([claims]: Parameters<typeof createDocumentGrant>) => claims.operations)).toEqual([['seed'], ['read', 'comment']]);
  expect(markDocumentMappingReady).toHaveBeenCalledWith(result.documentId, 'source-revision');
  expect(result.sourceId).toBe(source.id);
  expect(result.canEdit).toBe(false);
});
it('never marks a rejected seed ready or hands its credential to the browser', async () => {
  rejectSeed = true;
  await expect(connectDocumentCanvas(source, session, true)).rejects.toThrow('rejected');
  expect(markDocumentMappingReady).not.toHaveBeenCalled();
  expect(createDocumentGrant).toHaveBeenCalledTimes(1);
});
it('refreshes grants without reconstructing already migrated content', async () => {
  jest.mocked(ensureDocumentMapping).mockResolvedValueOnce({ tenant_id: 'assessment', source_namespace: 'knowledge', source_id: source.id,
    document_id: '00000000-0000-4000-a000-000000000001', source_revision: 'old-source', schema_version: 2, migration_state: 'ready', owner_sub: null, published_revision: null });
  const result = await connectDocumentCanvas(source, session, true);
  expect(createCanvasSeed).not.toHaveBeenCalled();
  expect(result.sourceRevision).toBe('old-source');
  expect(jest.mocked(createDocumentGrant).mock.calls[0]![0].operations).toEqual(['read', 'comment', 'edit']);
});
it('refuses a revoked session before creating any document mapping', async () => {
  jest.mocked(currentDocumentSessionEpoch).mockResolvedValueOnce(null);
  await expect(connectDocumentCanvas(source, session, true)).rejects.toThrow('no longer authorized');
  expect(ensureDocumentMapping).not.toHaveBeenCalled();
});
it('projects the acknowledged version rather than the initial subscription body', async () => {
  const result = await readDocumentCanvasProjection(source, session);
  expect(actions).toEqual(['seedDocument', 'subscribe', 'saveVersion', 'getSnapshotAtVersion']);
  expect(result).toMatchObject({ markdown: '# Acknowledged binary', version: '1234', sourceRevision: 'source-revision' });
});
it('does not publish a projection when the durable version was rejected', async () => {
  rejectVersion = true;
  await expect(readDocumentCanvasProjection(source, session)).rejects.toThrow('rejected');
  expect(actions).not.toContain('getSnapshotAtVersion');
});
it('rewrites source attachments only at seed time', async () => {
  await connectDocumentCanvas({ ...source, markdown: '![Diagram](attachment:diagram.png)' }, session, false);
  expect(createCanvasSeed).toHaveBeenCalledWith('![Diagram](/api/assessment/knowledge/source/asset?id=page%3A100002&name=diagram.png)', { schema: {} });
});
it('reports explicit source-manager capability without putting manage in a browser grant', async () => {
  jest.mocked(ensureDocumentMapping).mockResolvedValueOnce({ tenant_id: 'assessment', source_namespace: 'knowledge', source_id: source.id,
    document_id: '00000000-0000-4000-a000-000000000001', source_revision: 'source-revision', schema_version: 2, migration_state: 'ready', owner_sub: session.sub, published_revision: null });
  const result = await connectDocumentCanvas(source, session, true);
  expect(result.canManageWorkflow).toBe(true);
  expect(jest.mocked(createDocumentGrant).mock.calls[0]![0].operations).toEqual(['read', 'comment', 'edit']);
});
it('does not grant workflow management to another source owner even when requested by the server', async () => {
  jest.mocked(ensureDocumentMapping).mockResolvedValueOnce({ tenant_id: 'assessment', source_namespace: 'knowledge', source_id: source.id,
    document_id: '00000000-0000-4000-a000-000000000001', source_revision: 'source-revision', schema_version: 2, migration_state: 'ready', owner_sub: 'another-owner', published_revision: null });
  const result = await connectDocumentCanvas(source, session, true, { workflowManage: true });
  expect(result.canManageWorkflow).toBe(false);
  expect(jest.mocked(createDocumentGrant).mock.calls[0]![0].operations).not.toContain('manage');
});

it('does not delegate a global administrator from the wrong current tenant',async()=>{
 await expect(connectDocumentCanvas(source,{...session,tenant:'orgiq',role:'admin',grants:{orgiq:['admin'],assessment:['admin']}},true)).rejects.toThrow('assessment session');
 expect(ensureDocumentMapping).not.toHaveBeenCalled();
 expect(createDocumentGrant).not.toHaveBeenCalled();
});
it('rechecks editing authority inside the grant issuer even when a caller requests edit',async()=>{
 const {isAllowed}=await import('../../lib/authz.js');
 jest.mocked(isAllowed).mockImplementation(async(_session,action)=>action==='ViewAssessment');
 const result=await connectDocumentCanvas(source,session,true);
 expect(result.canEdit).toBe(false);
 expect(jest.mocked(createDocumentGrant).mock.calls.at(-1)![0].operations).toEqual(['read','comment']);
 jest.mocked(isAllowed).mockResolvedValue(true);
});
it('edits a prompt through its draft, but never projects that draft as a publication', async () => {
  const prompt = { id: 'prompt:classify-transcript.md', title: 'Classify Transcript', classification: 'internal', markdown: '# Classify', editable: false };
  const result = await connectDocumentCanvas(prompt, session, true);
  expect(result.canEdit).toBe(true);
  expect(jest.mocked(createDocumentGrant).mock.calls.at(-1)![0].operations).toEqual(['read', 'comment', 'edit']);
  await expect(readDocumentCanvasProjection(prompt, session)).rejects.toThrow('not authorized');
});

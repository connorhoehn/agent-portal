jest.mock('../assessment.js', () => ({ getKnowledgeDoc: jest.fn() }));
jest.mock('../document-canvas.js', () => ({ documentWorkflowAccess: jest.fn() }));
jest.mock('../document-workflows.js', () => ({ ...jest.requireActual('../document-workflows.js'), performDocumentWorkflow: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { changeDocumentVersion, exchangeVersion } from '../document-versions.js';
import { documentWorkflowAccess } from '../document-canvas.js';
import { getKnowledgeDoc } from '../assessment.js';
import { performDocumentWorkflow } from '../document-workflows.js';
import { isAllowed } from '../../lib/authz.js';
import type { Session } from '../../lib/session.js';
const session: Session = { sub: 'owner', role: 'lead-assessor', tenant: 'assessment', iat: 0, grants: { assessment: ['lead-assessor'] } };
const documentId = '00000000-0000-4000-a000-000000000001';
const server = createServer(); const wss = new WebSocketServer({ server });
const originalUrl = process.env['DOCUMENT_GATEWAY_INTERNAL_URL'];
let url: string; let lastAction: Record<string, unknown>; let mismatched = false;
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env['DOCUMENT_GATEWAY_INTERNAL_URL'] = url;
  wss.on('connection', socket => socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.action === 'subscribe') socket.send(JSON.stringify({ type: 'crdt:snapshot', channel: message.channel, update: '' }));
    else { lastAction = message; socket.send(JSON.stringify({ type: 'crdt', channel: message.channel,
      action: message.action === 'saveVersion' ? 'versionSaved' : 'snapshotRestored', timestamp: mismatched ? 999 : message.timestamp || 123, name: message.name })); }
  }));
});
afterAll(async () => { if (originalUrl === undefined) delete process.env['DOCUMENT_GATEWAY_INTERNAL_URL']; else process.env['DOCUMENT_GATEWAY_INTERNAL_URL'] = originalUrl; for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  jest.clearAllMocks(); mismatched = false; lastAction = {};
  jest.mocked(isAllowed).mockResolvedValue(true);
  jest.mocked(getKnowledgeDoc).mockResolvedValue({ id: 'page:1', title: 'Doc', classification: 'synced', markdown: '', editable: false, path: '', updated_at: '' });
  jest.mocked(documentWorkflowAccess).mockResolvedValue({ documentId, sourceId: 'page:1', title: 'Doc', classification: 'synced', canEdit: true, canManageWorkflow: true, gatewayUrl: url, token: 'server-only-grant', sourceRevision: 'revision', expiresAt: 0 });
  jest.mocked(performDocumentWorkflow).mockImplementation(async (_id, _session, op) => ({ status: 200, body: op.kind === 'write-policy' ? { documentId, canWrite: true } : { documentId, lifecycle: { ownerId: session.sub } } }));
});
it('saves only after hydration and returns the actual acknowledged version', async () => {
  expect(await changeDocumentVersion('page:1', session, { action: 'save', name: 'Before change' })).toEqual({ timestamp: 123, name: 'Before change' });
  expect(lastAction).toEqual({ service: 'crdt', channel: `doc:${documentId}`, action: 'saveVersion', name: 'Before change' });
  expect(lastAction).not.toHaveProperty('userId');
});
it('uses canonical binary restore with owner and lifecycle checks', async () => {
  expect(await changeDocumentVersion('page:1', session, { action: 'restore', timestamp: 456 })).toEqual({ timestamp: 456, restored: true });
  expect(lastAction).toEqual({ service: 'crdt', channel: `doc:${documentId}`, action: 'restoreSnapshot', timestamp: 456 });
});
it('refuses a knowledge reader before opening transport', async () => {
  jest.mocked(isAllowed).mockResolvedValue(false);
  await expect(changeDocumentVersion('page:1', session, { action: 'save' })).rejects.toMatchObject({ status: 403 }); expect(documentWorkflowAccess).not.toHaveBeenCalled();
});
it.each(['save','restore'] as const)('refuses %s when lifecycle content is locked', async action => {
  jest.mocked(performDocumentWorkflow).mockResolvedValue({ status: 200, body: { documentId, canWrite: false } });
  await expect(changeDocumentVersion('page:1', session, action === 'save' ? { action } : { action, timestamp: 456 })).rejects.toMatchObject({ status: 409 }); expect(lastAction).toEqual({});
});
it('does not let a non-owner restore using editing authority', async () => {
  jest.mocked(performDocumentWorkflow).mockResolvedValueOnce({ status: 200, body: { documentId, canWrite: true } }).mockResolvedValueOnce({ status: 200, body: { documentId, lifecycle: { ownerId: 'someone-else' } } });
  await expect(changeDocumentVersion('page:1', session, { action: 'restore', timestamp: 456 })).rejects.toMatchObject({ status: 403 }); expect(lastAction).toEqual({});
});
it('does not report a different restore receipt as success', async () => {
  mismatched = true;
  await expect(exchangeVersion(url, 'server-only-grant', documentId, { action: 'restore', timestamp: 456 })).rejects.toMatchObject({ status: 503 });
});

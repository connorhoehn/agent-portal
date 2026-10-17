// Read-only adoption probe: library services + isolated memory stores only.
// No listeners, credentials, network calls, or application data.
const path = require('node:path');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
const project = path.resolve(process.argv[2] || path.join(root, 'middleware'));
const packageName = process.argv[3] || '@connorhoehn/realtime-modules';
const localRequire = createRequire(path.join(project, 'package.json'));
const { CRDTService, SnapshotManager, MemorySnapshotStore, MemoryMetadataStore } = localRequire(`${packageName}/server`);
const Y = localRequire('yjs');
const packagePath = path.resolve(path.dirname(localRequire.resolve(`${packageName}/server`)), '../../package.json');
const version = JSON.parse(fs.readFileSync(packagePath)).version;
const logger = { debug() {}, info() {}, warn() {}, error() {} };
(async () => {
  const metadataStore = new MemoryMetadataStore();
  const snapshotStore = new MemorySnapshotStore();
  const frames = [];
  let policyCalls = 0;
  const service = new CRDTService({
    metadataStore, snapshotStore, logger,
    authz: () => { policyCalls++; return false; },
    messageRouter: {
      sendToChannel() {}, broadcastToAll() {}, subscribeToChannel() {}, unsubscribeFromChannel() {},
      sendToClient(_id, frame) { frames.push(frame); },
      getClientData() { return { userContext: { userId: 'isolated-research-user' } }; },
    },
  });
  const ydoc = new Y.Doc();
  ydoc.getText('content').insert(0, 'isolated in-memory probe');
  const channel = 'doc:research-probe';
  try {
    await service.handleAction('probe-connection', 'subscribe', { channel });
    const subscribePolicyCalls = policyCalls;
    await service.handleAction('probe-connection', 'update', { channel, update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64') });
    const updatePolicyCalls = policyCalls - subscribePolicyCalls;
    const contentAfterDeniedSubscribe = service.channelStates.get(channel)?.ydoc.getText('content').toString() ?? '';
    let capturedMeta;
    const state = { ydoc, operationsSinceSnapshot: 1, subscriberCount: 0, hydrated: true };
    const manager = new SnapshotManager({ logger, getChannelState: () => state,
      snapshotStore: { ...snapshotStore, async putSnapshot(_channel, _bytes, meta) { capturedMeta = meta; } } });
    await manager.writeSnapshot(channel, { type: 'manual', author: 'isolated-research-user', name: 'Named version' });
    const failingManager = new SnapshotManager({ logger, getChannelState: () => state,
      snapshotStore: { ...snapshotStore, async putSnapshot() { throw Error('deliberate isolated store failure'); } } });
    let rejected = false;
    try { await failingManager.writeSnapshot(channel, { type: 'manual' }); } catch { rejected = true; }
    console.log(JSON.stringify({ packageName, version, subscribePolicyCalls, updatePolicyCalls,
      updateAppliedAfterDeniedSubscribe: contentAfterDeniedSubscribe.length > 0,
      snapshotMetadataFields: Object.keys(capturedMeta ?? {}).sort(),
      snapshotStoreFailureRejects: rejected }, null, 2));
  } finally {
    await service.shutdown();
    ydoc.destroy();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

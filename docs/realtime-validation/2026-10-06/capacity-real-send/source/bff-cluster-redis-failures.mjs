// Dedicated local Redis fault contracts. Commands target only the inspected
// bff-cluster container, never other Redis stacks or cloud resources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bases, login, connect, call, request, send, until, close, upgradeStatus, joinHuddle, sendHuddle, receivedHuddle } from './bff-cluster-fixture.mjs';
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.env.ORGIQ_BFF_REDIS_FAILURE_ACCEPTANCE !== '1') throw new Error('Opt in to the owned local Redis failure contracts');
async function ownedRedis() {
  const rows = JSON.parse((await execute('docker', ['inspect', 'orgiq-bff-cluster-redis'])).stdout);
  assert.equal(rows.length, 1); const row = rows[0];
  assert.equal(row.Name, '/orgiq-bff-cluster-redis');
  assert.equal(row.Config.Labels['orgiq.validation'], 'bff-cluster');
  assert.equal(row.State.Running, true);
  assert.deepEqual(row.HostConfig.PortBindings['6379/tcp'], [{ HostIp: '127.0.0.1', HostPort: '16483' }]);
  return row.Id;
}
async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(6000) });
  return { status: response.status, body: await response.json() };
}
async function restartOwned() {
  if (!process.env.ORGIQ_BFF_RUNTIME_ENV_FILE) throw new Error('Set the private owned runtime profile for recovery');
  await execute('python3', [fileURLToPath(new URL('./bff-cluster-processes.py', import.meta.url))]);
  await until(async () => {
    try { return (await Promise.all([3063, 3064].map(health))).every(row => row.status === 200 && row.body.realtime.ready === true); } catch { return false; }
  }, 'fresh healthy gateway owners', 10000);
}
test('losing a subscriber connection permanently removes both leased BFFs from health admission', { timeout: 20000 }, async () => {
  const id = await ownedRedis();
  for (const port of [3063, 3064]) assert.equal((await health(port)).status, 200);
  const killed = (await execute('docker', ['exec', id, 'redis-cli', 'CLIENT', 'KILL', 'TYPE', 'pubsub'])).stdout.trim();
  assert.ok(Number(killed) >= 2, 'actual subscribed sockets were disconnected');
  const deadline = Date.now() + 5000;
  let results;
  do { results = await Promise.all([3063, 3064].map(health)); if (results.every(row => row.status === 503)) break; await pause(50); } while (Date.now() < deadline);
  assert.deepEqual(results.map(row => row.status), [503, 503], 'fenced gateways are unhealthy to the existing ALB health path');
  for (const row of results) { assert.equal(row.body.realtime.ready, false); assert.equal(row.body.status, 'degraded'); }
  await pause(600);
  assert.equal((await execute('docker', ['exec', id, 'redis-cli', 'PING'])).stdout.trim(), 'PONG');
  // Redis client reconnect must not revive the old leased router incarnation.
  assert.deepEqual((await Promise.all([3063, 3064].map(health))).map(row => row.status), [503, 503]);
});

test('retirement after peer connection loss preserves page ownership and both users\' huddle history', { timeout: 20000 }, async () => {
  await restartOwned();
  const alicePrincipal = await login(0, 'u-theo'), bobPrincipal = await login(1, 'u-vera');
  const alice = await connect(alicePrincipal), bob = await connect(bobPrincipal);
  let recoveredAlice, recoveredBob;
  try {
    const callId = await call(alice, bob), lobbyName = 'orgiq:initiative:cluster-project';
    const page = await request(alice, `/api/calls/${callId}/page`, 'PUT', { expectedRevision: 0, page: { kind: 'work-item', id: 'cluster-work' } });
    assert.equal(page.status, 200);
    for (const peer of [alice, bob]) await joinHuddle(peer, callId);
    const message = { body: { message: await sendHuddle(alice, callId, 'Before subscriber failure') } };
    await until(() => receivedHuddle(bob, message.body.message.id), 'initial actual peer delivery');
    const id = await ownedRedis();
    assert.ok(Number((await execute('docker', ['exec', id, 'redis-cli', 'CLIENT', 'KILL', 'TYPE', 'pubsub'])).stdout.trim()) >= 2);
    await until(async () => (await Promise.all([3063, 3064].map(health))).every(row => row.status === 503), 'immediate permanent fencing');
    for (const node of [0, 1]) assert.equal(await upgradeStatus(alicePrincipal, node), 401, 'fenced owner refuses new upgrades');
    await restartOwned();
    recoveredAlice = await connect(alicePrincipal); recoveredBob = await connect(bobPrincipal);
    assert.notEqual(recoveredAlice.id, alice.id); assert.notEqual(recoveredBob.id, bob.id);
    for (const [peer, other] of [[recoveredAlice, recoveredBob], [recoveredBob, recoveredAlice]]) {
      send(peer, { service: 'call', action: 'participant-state', callId, lobbyName, callerId: peer.userId,
        userId: peer.userId, status: 'in-call', targetUserIds: [other.userId] });
    }
    await until(async () => (await request(recoveredAlice, `/api/calls/${callId}/chat`)).body.participants?.length === 2, 'both accepted seats recover');
    for (const peer of [recoveredAlice, recoveredBob]) {
      const history = await request(peer, `/api/calls/${callId}/chat`);
      assert.equal(history.status, 200);
      assert.ok(history.body.messages.some(row => row.id === message.body.message.id), 'recovery preserves the existing history floor');
      const snapshot = await request(peer, `/api/calls/${callId}/page`);
      assert.equal(snapshot.status, 200); assert.equal(snapshot.body.page.id, 'cluster-work');
      assert.equal(snapshot.body.revision, page.body.revision);
    }
    assert.equal((await request(recoveredBob, `/api/calls/${callId}/page`, 'DELETE', { expectedRevision: page.body.revision })).status, 403);
    for (const peer of [recoveredAlice, recoveredBob]) await joinHuddle(peer, callId);
    const sent = { body: { message: await sendHuddle(recoveredAlice, callId, 'After replacement owners') } };
    await until(() => receivedHuddle(recoveredBob, sent.body.message.id), 'replacement peer delivery');
  } finally { close(alice, bob); if (recoveredAlice) close(recoveredAlice); if (recoveredBob) close(recoveredBob); }
});

test('a stalled Redis command path fences health within its bounded renewal deadline', { timeout: 55000 }, async () => {
  await restartOwned(); const id = await ownedRedis();
  await execute('docker', ['pause', id]);
  try {
    await until(async () => (await Promise.all([3063, 3064].map(health))).every(row => row.status === 503), 'failed bounded lease renewal', 18000);
    for (const port of [3063, 3064]) {
      const before = performance.now(), result = await health(port);
      assert.equal(result.status, 503); assert.equal(result.body.realtime.ready, false);
      assert.ok(performance.now() - before < 1000, 'fenced health does not wait for unrelated credential/datastore probes');
    }
  } finally { await execute('docker', ['unpause', id]); }
  await pause(400);
  assert.equal((await execute('docker', ['exec', id, 'redis-cli', 'PING'])).stdout.trim(), 'PONG');
  assert.deepEqual((await Promise.all([3063, 3064].map(health))).map(row => row.status), [503, 503], 'late recovery cannot revive old ownership');
  // The destroyed command connection cannot release the old owner lease.
  // These fixture nodes intentionally reuse stable IDs; respect their TTL
  // rather than deleting lease keys or stealing a live incarnation.
  await until(async () => {
    const keys = (await execute('docker', ['exec', id, 'redis-cli', '--scan', '--pattern', '*orgiq-bff-cluster-acceptance*node:*'])).stdout.trim();
    return keys === '';
  }, 'old stable owner leases expire naturally', 31000);
  await restartOwned();
});

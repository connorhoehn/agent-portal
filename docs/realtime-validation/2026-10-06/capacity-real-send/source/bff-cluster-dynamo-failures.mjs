// Read-only outage contract against the inspected dedicated DynamoDB Local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { login, connect, call, request, until, close, joinHuddle, sendHuddle, receivedHuddle } from './bff-cluster-fixture.mjs';
const execute = promisify(execFile);
if (process.env.ORGIQ_BFF_DYNAMO_FAILURE_ACCEPTANCE !== '1') throw new Error('Opt in to the dedicated local DynamoDB failure contract');
test('stalled durable history reads have a deadline, preserve accepted seats and recover existing huddle history', { timeout: 45000 }, async () => {
  const rows = JSON.parse((await execute('docker', ['inspect', 'orgiq-bff-cluster-dynamodb'])).stdout);
  assert.equal(rows.length, 1); const node = rows[0];
  assert.equal(node.Name, '/orgiq-bff-cluster-dynamodb');
  assert.equal(node.Config.Labels['orgiq.validation'], 'bff-cluster');
  assert.equal(node.State.Running, true); assert.equal(node.State.Paused, false);
  assert.deepEqual(node.HostConfig.PortBindings['8000/tcp'], [{ HostIp: '127.0.0.1', HostPort: '18063' }]);
  const alice = await connect(await login(0, 'u-theo')), bob = await connect(await login(1, 'u-vera'));
  try {
    const callId = await call(alice, bob);
    const page = await request(alice, `/api/calls/${callId}/page`, 'PUT', { expectedRevision: 0, page: { kind: 'work-item', id: 'cluster-work' } });
    assert.equal(page.status, 200);
    for (const peer of [alice, bob]) await joinHuddle(peer, callId);
    const sent = { body: { message: await sendHuddle(alice, callId, 'Before durable store stall') } };
    await until(() => receivedHuddle(bob, sent.body.message.id), 'actual pre-outage peer delivery');
    await execute('docker', ['pause', node.Id]);
    try {
      const started = performance.now();
      const unavailable = await request(alice, `/api/calls/${callId}/chat`);
      assert.ok(performance.now() - started < 24000, 'SDK attempts and their reply deadlines are bounded');
      assert.equal(unavailable.status, 503, 'durable unavailability is a retryable read failure');
      assert.equal(unavailable.body.messages, undefined, 'a failed authoritative read cannot become an empty or cached transcript');
    } finally { await execute('docker', ['unpause', node.Id]); }
    const history = await request(alice, `/api/calls/${callId}/chat`);
    assert.equal(history.status, 200); assert.equal(history.body.participants.length, 2);
    assert.ok(history.body.messages.some(message => message.id === sent.body.message.id));
    const restored = await request(bob, `/api/calls/${callId}/page`);
    assert.equal(restored.status, 200); assert.equal(restored.body.page.id, 'cluster-work');
    assert.equal(restored.body.revision, page.body.revision);
  } finally { close(alice, bob); }
});

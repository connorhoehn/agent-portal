import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  assertContainerName, assertGatewayTarget, assertRedisGatewayHealth, assertRestartTarget,
  mintToken, parseArgs, readIdentityManifest, recoveryComplete, Run,
} from './realtime-calls.mjs';

const requireMw = createRequire(new URL('../../middleware/package.json', import.meta.url));
const { jwtVerify } = requireMw('jose');
const args = (...values) => parseArgs(['node', 'driver', ...values]);

test('the background cadence and synchronized startup burst are explicit separate workloads', () => {
  assert.equal(args().chatStartup, 'spread');
  assert.equal(args('--chat-startup', 'burst').chatStartup, 'burst');
  assert.throws(() => args('--chat-startup', 'disabled'), /spread or burst/);
});

test('restart is explicit, local, bounded and cannot be selected by the ordinary all profile', () => {
  assert.equal(args('--scenario', 'all').restartContainer, null);
  assert.throws(() => args('--scenario', 'restart'), /requires/);
  assert.throws(() => args('--scenario', 'steady', '--restart-container', 'gateway'), /require --scenario/);
  assert.throws(() => args('--scenario', 'restart', '--restart-container', 'gateway', '--redis-container', 'redis', '--url', 'wss://example.com/ws'), /loopback/);
  assert.throws(() => args('--scenario', 'restart', '--restart-container', 'gateway', '--redis-container', 'redis', '--soak-seconds', '200'), /budget/);
  assert.throws(() => args('--token-ttl-seconds', '601'), /tokenTtlSeconds/);
  assert.throws(() => args('--soak-seconds', 'Infinity'), /soakSeconds/);
  const o = args('--scenario', 'restart', '--restart-container', 'orgiq-soak-gateway', '--redis-container', 'orgiq-soak-redis');
  assert.equal(o.sampleContainer, 'orgiq-soak-gateway');
  assert.equal(o.soakSeconds, 300);
});

test('container names cannot carry Docker options, selectors or shell code', () => {
  for (const name of ['--all', 'gateway;exit', '$(whoami)', 'a b', 'a/b', '', '*']) assert.throws(() => assertContainerName(name));
  assert.doesNotThrow(() => assertContainerName('orgiq-soak-gateway'));
});

test('peer targets require distinct authenticated gateway endpoints and refuse ambiguous container operations', () => {
  assert.deepEqual(args('--peer-url', 'ws://127.0.0.1:3064/ws').peerUrls, ['ws://127.0.0.1:3064/ws']);
  for (const url of ['http://127.0.0.1:3064/ws', 'ws://user:password@127.0.0.1:3064/ws', 'ws://127.0.0.1:3064/other', 'ws://127.0.0.1:3064/ws?token=x']) {
    assert.throws(() => args('--peer-url', url), /Targets require/);
  }
  assert.throws(() => args('--peer-url', 'ws://127.0.0.1:3031/ws'), /distinct/);
  assert.throws(() => args('--peer-url', 'ws://127.0.0.1:3064/ws', '--sample-container', 'gateway'), /one exact name/);
  const sampled = args('--url', 'ws://127.0.0.1:3065/ws', '--peer-url', 'ws://127.0.0.1:3066/ws', '--sample-container', 'gateway-a', '--peer-container', 'gateway-b');
  assert.deepEqual(sampled.peerContainers, ['gateway-b']);
  assert.throws(() => args('--peer-container', 'gateway-b'), /primary container/);
  assert.throws(() => args('--peer-url', 'ws://127.0.0.1:3064/ws', '--sample-container', 'same', '--peer-container', 'same'), /distinct/);
});

test('restart health refuses another service, disabled gateways and memory stores', () => {
  for (const data of [null, { service: 'other' }, { service: 'orgiq-middleware', realtime: { gateway: 'off', store: 'redis' } }, { service: 'orgiq-middleware', realtime: { gateway: 'on', store: 'memory' } }, { service: 'orgiq-middleware', realtime: { gateway: 'on', store: 'redis', ready: false } }]) assert.throws(() => assertRedisGatewayHealth(data));
  assert.doesNotThrow(() => assertRedisGatewayHealth({ service: 'orgiq-middleware', realtime: { gateway: 'on', store: 'redis' } }));
});

test('restart target validates exact container identity and the loopback port before any mutation', async () => {
  const o = args('--scenario', 'restart', '--restart-container', 'gateway', '--redis-container', 'redis');
  const commands = [];
  const command = async (a) => {
    commands.push(a);
    return JSON.stringify([{ Name: '/someone-elses-gateway', State: { Running: true } }]);
  };
  await assert.rejects(assertRestartTarget(o, command), /exact name/);
  assert.deepEqual(commands, [['inspect', '--type', 'container', 'gateway']]);
  await assert.rejects(assertRestartTarget(o, async (a) => JSON.stringify([{ Name: `/${a.at(-1)}`, State: { Running: true }, NetworkSettings: { Ports: { '3001/tcp': [{ HostIp: '0.0.0.0', HostPort: '3031' }] } } }])), /loopback/);
});

function dockerDriverFixture() {
  const id = 'a'.repeat(64);
  const o = args('--scenario', 'soak', '--driver-container', 'driver', '--sample-container', 'gateway', '--url', 'ws://gateway-alias:3001/ws');
  const containers = {
    gateway: { Name: '/gateway', State: { Running: true }, Config: { ExposedPorts: { '3001/tcp': {} } }, NetworkSettings: { Networks: { soak: { NetworkID: 'shared-network', Aliases: ['gateway-alias'] } } } },
    driver: { Id: id, Name: '/driver', State: { Running: true }, Config: { Hostname: id.slice(0, 12) }, NetworkSettings: { Networks: { soak: { NetworkID: 'shared-network' } } } },
    redis: { Name: '/redis', State: { Running: true }, NetworkSettings: { Networks: { soak: { NetworkID: 'shared-network' } } } },
  };
  const command = async (a) => {
    assert.equal(a[0], 'inspect', 'the target guard must remain read-only');
    return JSON.stringify([containers[a.at(-1)]]);
  };
  const runtime = { platform: 'linux', hostname: id.slice(0, 12), containerHostname: id.slice(0, 12) };
  return { o, containers, command, runtime };
}

test('Docker driver allows an exact gateway alias only in its own runtime and shared network', async () => {
  const { o, command, runtime } = dockerDriverFixture();
  assert.deepEqual((await assertGatewayTarget(o, command, runtime)).networkIds, ['shared-network']);
  await assertGatewayTarget({ ...o, url: 'ws://gateway:3001/ws', healthUrl: 'http://gateway:3001/api/health' }, command, runtime);
  assert.throws(() => args('--driver-container', 'driver'), /requires a named gateway/);
  assert.throws(() => args('--driver-container', 'gateway', '--sample-container', 'gateway'), /must differ/);
  assert.throws(() => args('--driver-container', 'driver', '--sample-container', 'gateway', '--server-pid', '1'), /container stats/);
  assert.throws(() => args('--scenario', 'restart', '--restart-container', 'gateway', '--redis-container', 'redis', '--sample-container', 'someone-else'), /stats must sample/);
});

test('Docker DNS exception refuses host execution, foreign aliases, isolated networks and wrong ports', async () => {
  const { o, containers, command, runtime } = dockerDriverFixture();
  for (const invalid of [{ ...runtime, platform: 'darwin' }, { ...runtime, hostname: 'host' }, { ...runtime, containerHostname: 'other-container' }]) {
    await assert.rejects(assertGatewayTarget(o, command, invalid), /this running Docker driver/);
  }
  await assert.rejects(assertGatewayTarget({ ...o, healthUrl: 'http://someone-else:3001/api/health' }, command, runtime), /same gateway/);
  await assert.rejects(assertGatewayTarget({ ...o, url: 'ws://foreign:3001/ws', healthUrl: 'http://foreign:3001/api/health' }, command, runtime), /exact gateway alias/);
  await assert.rejects(assertGatewayTarget({ ...o, url: 'ws://gateway-alias:13061/ws', healthUrl: 'http://gateway-alias:13061/api/health' }, command, runtime), /internal TCP port/);
  containers.driver.NetworkSettings.Networks.soak.NetworkID = 'different-network';
  await assert.rejects(assertGatewayTarget(o, command, runtime), /shared Docker network/);
});

test('Docker restart refuses an unrelated Redis before health or restart operations', async () => {
  const { o, containers, command, runtime } = dockerDriverFixture();
  containers.redis.NetworkSettings.Networks.soak.NetworkID = 'different-network';
  await assert.rejects(assertRestartTarget({ ...o, restartContainer: 'gateway', redisContainer: 'redis' }, command, runtime), /Redis must share/);
});

test('reauthentication tokens use a fresh bounded expiry, issuer, audience and tenant', async () => {
  const secret = 'test-realtime-secret';
  const key = new TextEncoder().encode(secret);
  const old = await mintToken(secret, 'u-test', 'social', 600, 1000);
  const fresh = await mintToken(secret, 'u-test', 'social', 600, 1500);
  await assert.rejects(jwtVerify(old, key, { issuer: 'orgiq-middleware', audience: 'realtime', currentDate: new Date(1601_000) }), { code: 'ERR_JWT_EXPIRED' });
  const { payload } = await jwtVerify(fresh, key, { issuer: 'orgiq-middleware', audience: 'realtime', currentDate: new Date(1601_000) });
  assert.equal(payload.exp, 2100);
  assert.equal(payload.iat, 1500);
  assert.deepEqual(payload.tenants, ['social']);
  assert.equal(payload.tokenKind, 'orgiq-hs256');
});

test('directory manifests refuse missing authority, duplicate subjects and insufficient users', () => {
  const user = { userId: 'u-mira', displayName: 'Mira Okafor', role: 'community-admin', epoch: 3, tenants: ['social'] };
  assert.deepEqual(readIdentityManifest([user], 1), [user]);
  assert.throws(() => readIdentityManifest([user], 2), /enough distinct/);
  assert.throws(() => readIdentityManifest([user, user], 2), /duplicated/);
  for (const patch of [{ epoch: undefined }, { epoch: -1 }, { epoch: 1.5 }, { role: 'member' }, { tenants: ['orgiq'] }, { tenants: ['social', 'social'] }, { userId: 'social:forged' }]) {
    assert.throws(() => readIdentityManifest([{ ...user, ...patch }], 1), /invalid/);
  }
});

test('directory-backed token renewal preserves actual source role, epoch and tenant claims', async () => {
  const secret = 'test-realtime-secret', key = new TextEncoder().encode(secret);
  const identity = { userId: 'u-mira', displayName: 'Mira Okafor', role: 'community-admin', epoch: 3, tenants: ['social', 'orgiq'] };
  const old = await mintToken(secret, identity.userId, 'social', 30, 1000, identity);
  const renewed = await mintToken(secret, identity.userId, 'social', 30, 1020, identity);
  await assert.rejects(jwtVerify(old, key, { currentDate: new Date(1031_000) }), { code: 'ERR_JWT_EXPIRED' });
  const { payload } = await jwtVerify(renewed, key, { issuer: 'orgiq-middleware', audience: 'realtime', currentDate: new Date(1031_000) });
  assert.equal(payload.sub, identity.userId); assert.equal(payload.role, identity.role);
  assert.equal(payload.epoch, identity.epoch); assert.equal(payload.displayName, identity.displayName);
  assert.deepEqual(payload.tenants, identity.tenants);
  await assert.rejects(mintToken(secret, 'someone-else', 'social', 30, 1020, identity), /match its subject/);
});

function recoveryFixture() {
  const run = new Run(args('--sockets', '4', '--calls', '1'), 'restart', 2, () => { throw new Error('No container operations in this test'); });
  const call = { callId: 'original-call', lobby: 'social:dm:a:b', members: ['a', 'b'] };
  run.calls = [call];
  run.callById.set(call.callId, call);
  run.callById.set('old-call-in-same-lobby', call);
  const client = (userId, channel) => ({ userId, clientId: `fresh-${userId}`, lobbies: new Set([call.lobby]), chatChannels: new Set(channel ? [channel] : []), presenceChannels: new Set(channel ? [channel] : []) });
  const a = client('a'), b = client('b'), x = client('x', 'social:dm:x:y'), y = client('y', 'social:dm:x:y');
  const rec = {
    id: 'recovery-1', fresh: new Map([a, b, x, y].map((c) => [c.userId, c])), expectedSockets: 4,
    expectedCallStatus: 2, expectedParticipantStates: 2, expectedChat: 2, expectedPresence: 2,
    callStatus: new Set(), participantStates: new Set(), chatDelivered: new Set(), presenceSet: new Set(), presenceDelivered: new Set(), error: null,
  };
  run.recovery = rec;
  return { run, call, rec, a, b, x, y };
}

test('recovery requires the original call ID and complete roster on each new socket', () => {
  const { run, rec, a, b, call } = recoveryFixture();
  const status = (c, callId, users) => run.onFrame(c, { type: 'call', action: 'active-call', data: { callId, lobbyName: call.lobby, active: true, participantUserIds: users } });
  status(a, 'old-call-in-same-lobby', ['a', 'b']);
  status(a, call.callId, ['a']);
  status({ ...a, clientId: 'old-a' }, call.callId, ['a', 'b']);
  assert.equal(rec.callStatus.size, 0);
  status(a, call.callId, ['a', 'b']);
  status(b, call.callId, ['a', 'b']);
  assert.deepEqual([...rec.callStatus].sort(), ['a', 'b']);
  assert.equal(recoveryComplete(rec), false, 'a socket/session or status receipt alone is insufficient');
});

test('chat and presence recovery need fresh recipient sockets and current publisher IDs', () => {
  const { run, rec, x, y } = recoveryFixture();
  run.chatSent.set('lt|probe-x', { t: performance.now(), sender: 'x', recoveryId: rec.id });
  const chat = { type: 'chat', action: 'message', channel: 'social:dm:x:y', message: { message: 'lt|probe-x' } };
  run.onFrame({ ...y, clientId: 'old-y' }, chat);
  assert.equal(rec.chatDelivered.size, 0);
  run.onFrame(y, chat);
  assert.deepEqual([...rec.chatDelivered], ['x']);
  const presence = { type: 'presence', action: 'update', presence: { userId: 'x', clientId: 'old-x', status: 'online', channels: ['social:dm:x:y'] } };
  run.onFrame(y, presence);
  assert.equal(rec.presenceDelivered.size, 0);
  presence.presence.clientId = x.clientId;
  run.onFrame(y, presence);
  assert.deepEqual([...rec.presenceDelivered], ['x']);
});

test('all recovery evidence is required, and a driver/Redis error cannot count as recovery', () => {
  const { rec } = recoveryFixture();
  for (const [field, values] of [['callStatus', ['a', 'b']], ['participantStates', ['original-call|a|b', 'original-call|b|a']], ['chatDelivered', ['x', 'y']], ['presenceSet', ['x', 'y']], ['presenceDelivered', ['x', 'y']]]) {
    for (const value of values) rec[field].add(value);
  }
  assert.equal(recoveryComplete(rec), true);
  rec.presenceDelivered.delete('y');
  assert.equal(recoveryComplete(rec), false);
  rec.presenceDelivered.add('y');
  rec.error = 'Redis unavailable';
  assert.equal(recoveryComplete(rec), false);
});

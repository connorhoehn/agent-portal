// Full-process contracts; shared fixture code uses real local transports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { bases, db, durable, inbox, clients, pause, until, request, login, connect, send, call, close, upgradeStatus, seedUser, execute,
  huddleChannel, joinHuddle, sendHuddle, receivedHuddle } from './bff-cluster-fixture.mjs';

async function cookieSocket(principal, node) {
  const frames = [], ws = new WebSocket(bases[node].replace('http:', 'ws:') + '/realtime', {
    headers: { cookie: [...principal.jar].map(([key, value]) => `${key}=${value}`).join('; ') },
  });
  const client = { ...principal, ws, frames }; clients.add(client);
  ws.on('message', raw => frames.push(JSON.parse(String(raw)))); ws.on('error', () => {});
  const status = await new Promise(resolve => {
    ws.on('open', () => resolve(101));
    ws.on('unexpected-response', (_req, response) => { resolve(response.statusCode); ws.terminate(); });
  });
  client.status = status;
  return client;
}

test('two genuine tabs racing across full BFFs receive exactly one accepted seat', async () => {
  const alice = await connect(await login(0, 'u-theo'));
  const twins = [await connect(await login(0, 'u-vera')), await connect(await login(1, 'u-vera'))];
  try {
    for (let i = 0; i < 10; i++) {
      const callId = randomUUID(), lobbyName = 'orgiq:initiative:cluster-project';
      send(alice, { service: 'call', action: 'invite', callId, lobbyName, callerId: alice.userId, targetUserIds: ['u-vera'] });
      await until(() => twins.every(peer => peer.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId)), 'both real tab invites');
      for (const peer of twins) send(peer, { service: 'call', action: 'accepted', callId, lobbyName, callerId: peer.userId, targetUserIds: [alice.userId] });
      await until(() => twins.some(peer => peer.frames.some(frame => frame.action === 'ended' && frame.data?.callId === callId
        && frame.data?.reason === 'answered-elsewhere')), 'exact losing tab refusal');
      await until(() => alice.frames.some(frame => frame.action === 'accepted' && frame.data?.callId === callId), 'single actual answer');
      await pause(50);
      assert.equal(alice.frames.filter(frame => frame.action === 'accepted' && frame.data?.callId === callId).length, 1);
      const history = await request(alice, `/api/calls/${callId}/chat`);
      assert.equal(history.status, 200); assert.equal(history.body.participants.length, 2);
      send(alice, { service: 'call', action: 'ended', callId, lobbyName, callerId: alice.userId, targetUserIds: ['u-vera'] });
    }
  } finally { close(alice, ...twins); }
});

test('a real REST job producer reaches both cookie and JWT peers, then stops for a retired cookie epoch', async () => {
  await seedUser('cluster-distill-admin', [['orgiq', 'admin']]);
  const source = await login(0, 'u-theo'), peer = await login(1, 'u-vera'), operator = await login(0, 'cluster-distill-admin');
  const original = (await db.query('SELECT session_epoch FROM app_users WHERE id=$1', [peer.userId])).rows[0].session_epoch;
  const sockets = [await cookieSocket(source, 0), await cookieSocket(peer, 1), await connect(peer)];
  try {
    for (const socket of sockets) {
      if (socket.status !== undefined) assert.equal(socket.status, 101);
      send(socket, { service: 'subscribe', action: 'subscribe', channel: 'orgiq:distill:jobs' });
    }
    await until(() => sockets.every(socket => socket.frames.some(frame => frame.action === 'subscribed' && frame.channel === 'orgiq:distill:jobs')), 'both authenticated transports subscribe');
    const first = await request(operator, '/api/distillation/compact', 'POST', { level: 'L1', repo: 'orgiq/cluster-' + randomUUID().slice(0, 8) });
    assert.equal(first.status, 201);
    await until(() => sockets.every(socket => socket.frames.some(frame => frame.type === 'job' && frame.job?.id === first.body.id)), 'actual REST producer peer fanout');
    await db.query('UPDATE app_users SET session_epoch=session_epoch+1 WHERE id=$1', [peer.userId]);
    const second = await request(operator, '/api/distillation/compact', 'POST', { level: 'L1', repo: 'orgiq/cluster-' + randomUUID().slice(0, 8) });
    assert.equal(second.status, 201);
    await until(() => sockets[0].frames.some(frame => frame.job?.id === second.body.id), 'current source recipient remains live');
    await pause(250);
    assert.equal(sockets.slice(1).some(socket => socket.frames.some(frame => frame.job?.id === second.body.id)), false, 'retired recipients get no new REST job payload');
    for (const node of [0, 1]) {
      const refused = await cookieSocket(peer, node); assert.equal(refused.status, 401); close(refused);
    }
  } finally { await db.query('UPDATE app_users SET session_epoch=$2 WHERE id=$1', [peer.userId, original]); close(...sockets); }
});

test('two full BFFs share protected huddle messages and canonical Work pages', async () => {
  const alicePrincipal = await login(0, 'u-theo');
  const alice = await connect(alicePrincipal), bob = await connect(await login(1, 'u-vera'));
  let unseated;
  try {
    const callId = await call(alice, bob), channel = huddleChannel(callId);
    for (const peer of [alice, bob]) await joinHuddle(peer, callId);
    // Seat-only: the same user's second, unseated socket on the peer BFF is
    // refused join/send and is never handed the conversation.
    unseated = await connect({ ...alicePrincipal, base: bases[1] });
    const errorsBefore = unseated.frames.filter(frame => frame.type === 'error').length;
    send(unseated, { service: 'chat', action: 'join', channel });
    send(unseated, { service: 'chat', action: 'send', channel, message: 'Unseated', metadata: { clientDeliveryId: randomUUID() } });
    await until(() => unseated.frames.filter(frame => frame.type === 'error').length >= errorsBefore + 2, 'unseated socket refusals');
    const message = await sendHuddle(alice, callId, 'Native peer huddle');
    const sent = { body: { message } };
    await until(() => receivedHuddle(bob, sent.body.message.id), 'actual peer message');
    const delivered = bob.frames.find(frame => frame.message?.id === sent.body.message.id).message;
    assert.equal(delivered.userId, alice.userId);
    assert.equal(unseated.frames.some(frame => frame.type === 'chat' && frame.channel === channel
      && ['joined', 'message', 'history', 'sent'].includes(frame.action)), false, 'an unseated socket gets no huddle conversation');
    assert.equal((await request(alicePrincipal, `/api/calls/${callId}/chat`, 'GET', undefined, bob.base)).body.messages
      .filter(row => row.message === 'Unseated').length, 0, 'the refused send stored nothing');
    assert.equal(delivered.metadata._senderContext, undefined, 'private sender proof stays server-side');
    const page = await request(alice, `/api/calls/${callId}/page`, 'PUT', { expectedRevision: 0, page: { kind: 'work-item', id: 'cluster-work' } });
    assert.equal(page.status, 200);
    await until(() => bob.frames.some(frame => frame.type === 'call-page' && frame.page?.id === 'cluster-work'), 'peer canonical page');
    assert.equal((await request(alice, `/api/calls/${callId}/page`, 'GET', undefined, bob.base)).body.page.id, 'cluster-work');
    assert.equal((await request(bob, `/api/calls/${callId}/page`, 'DELETE', { expectedRevision: page.body.revision })).status, 403, 'peer cannot take caller stop rights');
    assert.equal((await request(alice, `/api/calls/${callId}/page`, 'DELETE', { expectedRevision: page.body.revision }, bob.base)).status, 200, 'caller can stop via the peer BFF');
    await until(() => bob.frames.some(frame => frame.type === 'call-page' && frame.revision > page.body.revision && frame.page === null), 'peer clear');
    const remoteHistory = await request(alice, `/api/calls/${callId}/chat`, 'GET', undefined, bob.base);
    assert.equal(remoteHistory.status, 200);
    assert.ok(remoteHistory.body.messages.some(message => message.id === sent.body.message.id));
  } finally { close(alice, bob); if (unseated) close(unseated); }
});

test('both BFFs refuse a retired real directory epoch and retain protected history', async () => {
  const alice = await connect(await login(0, 'u-theo')), bob = await connect(await login(1, 'u-vera'));
  const original = (await db.query('SELECT session_epoch FROM app_users WHERE id=$1', [alice.userId])).rows[0].session_epoch;
  try {
    const callId = await call(alice, bob);
    for (const peer of [alice, bob]) await joinHuddle(peer, callId);
    const first = { body: { message: await sendHuddle(alice, callId, 'Before directory retirement') } };
    await until(() => receivedHuddle(bob, first.body.message.id), 'pre-retirement peer delivery');
    await db.query('UPDATE app_users SET session_epoch=session_epoch+1 WHERE id=$1', [alice.userId]);
    for (const base of bases) assert.equal((await request(alice, `/api/calls/${callId}/chat`, 'GET', undefined, base)).status, 401);
    const start = alice.frames.length;
    const sent = { body: { message: await sendHuddle(bob, callId, 'After directory retirement') } };
    await pause(200);
    assert.equal(alice.frames.slice(start).some(frame => frame.message?.id === sent.body.message.id), false);
    const history = await request(bob, `/api/calls/${callId}/chat`);
    assert.equal(history.status, 200);
    assert.ok(history.body.messages.some(message => message.id === first.body.message.id), 'retirement preserves durable history');
    assert.equal(await upgradeStatus(alice), 401, 'retired JWT cannot upgrade on the other BFF');
  } finally { await db.query('UPDATE app_users SET session_epoch=$2 WHERE id=$1', [alice.userId, original]); close(alice, bob); }
});

test('forged caller and foreign lobby frames cannot cross the application boundary', async () => {
  const alice = await connect(await login(0, 'u-theo')), bob = await connect(await login(1, 'u-vera'));
  try {
    for (const [callerId, lobbyName] of [['u-vera', 'orgiq:initiative:cluster-project'], ['u-theo', 'assessment:private']]) {
      const callId = randomUUID(), start = alice.frames.length;
      send(alice, { service: 'call', action: 'invite', callerId, lobbyName, callId, targetUserIds: [bob.userId] });
      await until(() => alice.frames.slice(start).some(frame => frame.type === 'error'), 'source action refusal');
      await pause(100);
      assert.equal(bob.frames.some(frame => frame.data?.callId === callId), false);
    }
  } finally { close(alice, bob); }
});

test('a private channel created on one BFF is visible remotely and its remote leave revokes delivery', async () => {
  await seedUser('cluster-moderator', [['social', 'moderator'], ['orgiq', 'member']]);
  const owner = await connect(await login(0, 'cluster-moderator', 'social')), bob = await connect(await login(1, 'u-vera', 'social'));
  try {
    const created = await request(owner, '/api/social/channels', 'POST', { name: 'Peer ' + randomUUID().slice(0, 12), privacy: 'private' });
    assert.equal(created.status, 201);
    const { channel, slug } = created.body.channel;
    assert.equal((await request(bob, `/api/social/channels/${slug}`)).status, 404, 'private directory stays hidden');
    send(owner, { service: 'chat', action: 'join', channel });
    await until(() => owner.frames.some(frame => frame.action === 'joined' && frame.channel === channel), 'owner join');
    send(owner, { service: 'chat', action: 'addMembers', channel, userIds: [bob.userId], history: { mode: 'all' } });
    await until(async () => (await durable.members.getMember(channel, bob.userId))?.removedAt === null, 'durable member addition');
    assert.equal((await request(bob, `/api/social/channels/${slug}`)).status, 200, 'remote mirror refresh');
    send(bob, { service: 'chat', action: 'join', channel });
    await until(() => bob.frames.some(frame => frame.action === 'joined' && frame.channel === channel), 'peer private join');
    const reading = 'Private peer reader ' + randomUUID(), elsewhere = 'Private peer elsewhere ' + randomUUID();
    const alert = text => bob.frames.some(frame => frame.type === 'notification:new' && frame.payload?.channel === channel && frame.payload?.body === text);
    send(owner, { service: 'chat', action: 'send', channel, message: reading });
    await until(() => bob.frames.some(frame => frame.action === 'message' && frame.message?.message === reading), 'actual private peer reader delivery');
    await pause(400);
    assert.equal(alert(reading), false, 'a peer reading a private channel receives no unread alert');
    assert.equal((await inbox.list(bob.userId)).some(record => record.channel === channel && record.body === reading), false);
    send(bob, { service: 'chat', action: 'leave', channel });
    await until(() => bob.frames.some(frame => frame.action === 'left' && frame.channel === channel), 'private peer unsubscribe');
    send(owner, { service: 'chat', action: 'send', channel, message: elsewhere });
    await until(() => alert(elsewhere), 'private channel producer reaches an active member elsewhere');
    send(bob, { service: 'chat', action: 'join', channel });
    await until(() => bob.frames.filter(frame => frame.action === 'joined' && frame.channel === channel).length === 2, 'peer rejoins before durable removal');
    const left = await request(bob, `/api/social/channels/${slug}/leave`, 'POST', {}, owner.base);
    assert.equal(left.status, 200, 'membership is changed through the other full BFF');
    assert.equal((await request(bob, `/api/social/channels/${slug}`)).status, 404, 'completed removal is observed locally');
    const start = bob.frames.length;
    send(owner, { service: 'chat', action: 'send', channel, message: 'Private after leave', metadata: { clientDeliveryId: randomUUID() } });
    await until(async () => (await durable.listMessages(channel, 10)).some(message => message.message === 'Private after leave'), 'persisted source write');
    await pause(200);
    assert.equal(bob.frames.slice(start).some(frame => frame.action === 'message' && frame.channel === channel), false, 'last-mile member refusal');
  } finally { close(owner, bob); }
});

test('shared presence on the other BFF uses real identity and omits a revoked source', async () => {
  const alice = await connect(await login(0, 'u-theo')), bob = await connect(await login(1, 'u-vera'));
  const original = (await db.query('SELECT session_epoch FROM app_users WHERE id=$1', [alice.userId])).rows[0].session_epoch;
  const channel = 'orgiq:initiative:cluster-project';
  try {
    for (const peer of [alice, bob]) send(peer, { service: 'presence', action: 'set', status: 'online', channels: [channel], metadata: { userId: 'forged' } });
    await until(() => [alice, bob].every(peer => peer.frames.some(frame => frame.action === 'set' && frame.presence?.channels.includes(channel))), 'shared presence writes');
    async function roster() {
      const start = bob.frames.length; send(bob, { service: 'presence', action: 'get', channel });
      await until(() => bob.frames.slice(start).some(frame => frame.action === 'presence'), 'peer roster read');
      return bob.frames.slice(start).find(frame => frame.action === 'presence').data;
    }
    const before = await roster();
    assert.deepEqual(before.map(row => row.userId).sort(), ['u-theo', 'u-vera']);
    assert.equal(before.find(row => row.userId === 'u-theo').metadata.userId, 'u-theo');
    await db.query('UPDATE app_users SET session_epoch=session_epoch+1 WHERE id=$1', [alice.userId]);
    assert.deepEqual((await roster()).map(row => row.userId), ['u-vera']);
  } finally { await db.query('UPDATE app_users SET session_epoch=$2 WHERE id=$1', [alice.userId, original]); close(alice, bob); }
});

test('a missed-call notification reaches a peer BFF and replays from the shared inbox', async () => {
  const alice = await connect(await login(0, 'u-theo')), principal = await login(1, 'u-vera'), bob = await connect(principal);
  let returned;
  try {
    const callId = randomUUID(), lobbyName = 'orgiq:initiative:cluster-project';
    send(alice, { service: 'call', action: 'invite', callId, lobbyName, callerId: alice.userId, targetUserIds: [bob.userId] });
    await until(() => bob.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId), 'notification call invite');
    send(bob, { service: 'call', action: 'declined', callId, lobbyName, callerId: bob.userId, targetUserIds: [alice.userId] });
    await until(() => alice.frames.some(frame => frame.action === 'declined' && frame.data?.callId === callId), 'peer decline');
    send(alice, { service: 'call', action: 'cancelled', callId, lobbyName, callerId: alice.userId, targetUserIds: [bob.userId] });
    await until(() => bob.frames.some(frame => frame.type === 'notification:new' && frame.payload?.payload?.callId === callId), 'peer live inbox delivery');
    const record = bob.frames.find(frame => frame.type === 'notification:new' && frame.payload?.payload?.callId === callId).payload;
    assert.equal(record.payload.tenant, 'orgiq');
    close(bob);
    returned = await connect({ ...principal, base: bases[0] });
    await until(() => returned.frames.some(frame => frame.type === 'notification:bulk-update' && frame.payload.notifications.some(item => item.id === record.id)), 'unread replay on the other BFF');
  } finally { close(alice, bob); if (returned) close(returned); }
});

test('a peer DM reader avoids an unread alert and receives one after leaving', async () => {
  const suffix = randomUUID().slice(0, 8), ids = ['cluster-reader-a-' + suffix, 'cluster-reader-b-' + suffix];
  for (const id of ids) await seedUser(id, [['social', 'participant'], ['orgiq', 'member']]);
  const alice = await connect(await login(0, ids[0], 'social')), bob = await connect(await login(1, ids[1], 'social'));
  const channel = 'social:dm:' + ids.sort().join(':');
  const reading = 'Reading on peer ' + randomUUID(), elsewhere = 'After leaving peer ' + randomUUID();
  const alerts = text => bob.frames.filter(frame => frame.type === 'notification:new'
    && frame.payload?.type === 'message' && frame.payload?.channel === channel && frame.payload?.body === text);
  try {
    for (const peer of [alice, bob]) send(peer, { service: 'chat', action: 'join', channel });
    await until(() => [alice, bob].every(peer => peer.frames.some(frame => frame.action === 'joined' && frame.channel === channel)), 'both actual DM subscriptions');
    send(alice, { service: 'chat', action: 'send', channel, message: reading });
    await until(() => bob.frames.some(frame => frame.action === 'message' && frame.message?.message === reading), 'actual remote reader delivery');
    await pause(400);
    assert.equal(alerts(reading).length, 0, 'current readable peer subscription suppresses an unread alert');
    assert.equal((await inbox.list(bob.userId)).some(record => record.channel === channel && record.body === reading), false, 'no unnecessary unread record is persisted');
    send(bob, { service: 'chat', action: 'leave', channel });
    await until(() => bob.frames.some(frame => frame.action === 'left' && frame.channel === channel), 'actual peer unsubscribe receipt');
    send(alice, { service: 'chat', action: 'send', channel, message: elsewhere });
    await until(() => alerts(elsewhere).length === 1, 'actual message producer notifies the peer after leave');
    assert.equal(bob.frames.some(frame => frame.action === 'message' && frame.message?.message === elsewhere), false, 'the departed reader receives the alert without chat fanout');
  } finally { close(alice, bob); }
});

test('a full stored inbox replays across nodes and a later membership removal filters without deleting records', async () => {
  const suffix = randomUUID().slice(0, 8), ownerId = 'cluster-inbox-owner-' + suffix, readerId = 'cluster-inbox-reader-' + suffix;
  await seedUser(ownerId, [['social', 'moderator'], ['orgiq', 'member']]);
  await seedUser(readerId, [['social', 'participant'], ['orgiq', 'member']]);
  const owner = await connect(await login(0, ownerId, 'social')), principal = await login(1, readerId, 'social');
  let reader, returned;
  try {
    const created = await request(owner, '/api/social/channels', 'POST', { name: 'Inbox ' + suffix, privacy: 'private' });
    assert.equal(created.status, 201);
    const { channel, slug } = created.body.channel;
    send(owner, { service: 'chat', action: 'join', channel });
    await until(() => owner.frames.some(frame => frame.action === 'joined' && frame.channel === channel), 'inbox owner subscription');
    send(owner, { service: 'chat', action: 'addMembers', channel, userIds: [readerId], history: { mode: 'all' } });
    await until(async () => (await durable.members.getMember(channel, readerId))?.removedAt === null, 'stored inbox reader membership');
    const ids = new Set(), timestamp = Date.now();
    for (let i = 0; i < 200; i++) {
      const id = randomUUID(); ids.add(id);
      await inbox.append(readerId, { id, type: 'message', title: 'Private inbox reply', body: 'Stored record ' + i,
        timestamp: new Date(timestamp + i).toISOString(), channel,
        payload: { tenant: 'social', kind: 'message', channel, actorId: ownerId },
        action: { label: 'Open the channel', href: '/social/channels/' + encodeURIComponent(slug) } });
    }
    reader = await connect(principal);
    await until(() => reader.frames.some(frame => frame.type === 'notification:bulk-update'), 'actual stored inbox reply');
    assert.equal(reader.frames.find(frame => frame.type === 'notification:bulk-update').payload.notifications.filter(record => ids.has(record.id)).length,
      200, 'all 200 authorized notifications replay on a cold peer');
    close(reader);
    assert.equal((await request(principal, `/api/social/channels/${slug}/leave`, 'POST', {}, owner.base)).status, 200);
    returned = await connect({ ...principal, base: bases[0] });
    await until(() => returned.frames.some(frame => frame.type === 'notification:bulk-update'), 'fresh reply after completed remote removal');
    assert.equal(returned.frames.some(frame => frame.type === 'notification:bulk-update'
      && frame.payload.notifications.some(record => ids.has(record.id))), false, 'a later reply rereads current resource authority');
    assert.equal((await inbox.list(readerId)).filter(record => ids.has(record.id)).length, 200, 'filtering leaves the full persistent inbox intact');
  } finally { close(owner); if (reader) close(reader); if (returned) close(returned); }
});

test('retiring the real masquerade operator blocks admission on both BFFs', async () => {
  await seedUser('cluster-operator', [['orgiq', 'admin']]);
  const operator = await login(0, 'cluster-operator');
  const original = (await db.query('SELECT session_epoch FROM app_users WHERE id=$1', ['cluster-operator'])).rows[0].session_epoch;
  try {
    assert.equal((await request(operator, '/api/session/masquerade', 'POST', { userId: 'u-theo' })).status, 200);
    const issued = await request(operator, '/api/session/realtime-token');
    assert.equal(issued.status, 200);
    const claims = JSON.parse(Buffer.from(issued.body.token.split('.')[1], 'base64url').toString());
    assert.equal(claims.sub, 'u-theo'); assert.equal(claims.act.sub, 'cluster-operator');
    const impersonation = { ...operator, token: issued.body.token };
    assert.equal(await upgradeStatus(impersonation, 1), 101, 'current operator provenance is admitted');
    await db.query('UPDATE app_users SET session_epoch=session_epoch+1 WHERE id=$1', ['cluster-operator']);
    for (const node of [0, 1]) assert.equal(await upgradeStatus(impersonation, node), 401, 'operator epoch is authoritative across both processes');
  } finally { await db.query('UPDATE app_users SET session_epoch=$2 WHERE id=$1', ['cluster-operator', original]); }
});

test('an abruptly lost BFF returns under a new owner and restores the same authenticated call seat', {
  skip: process.env.ORGIQ_BFF_CLUSTER_CRASH_ACCEPTANCE !== '1', timeout: 60000,
}, async () => {
  if (!process.env.ORGIQ_BFF_RUNTIME_ENV_FILE) throw new Error('Crash acceptance requires the private owned runtime profile');
  const alice = await connect(await login(0, 'u-theo')), principal = await login(1, 'u-vera'), bob = await connect(principal);
  let returned;
  try {
    const callId = await call(alice, bob), lobbyName = 'orgiq:initiative:cluster-project';
    const page = await request(alice, `/api/calls/${callId}/page`, 'PUT', { expectedRevision: 0, page: { kind: 'work-item', id: 'cluster-work' } });
    assert.equal(page.status, 200);
    for (const peer of [alice, bob]) await joinHuddle(peer, callId);
    const stored = { body: { message: await sendHuddle(alice, callId, 'Before BFF crash') } };
    await until(() => receivedHuddle(bob, stored.body.message.id), 'pre-crash actual peer write');
    const pid = Number((await readFile('/tmp/orgiq-bff-cluster-b.pid', 'utf8')).trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const argv = (await execute('ps', ['-p', String(pid), '-o', 'args='])).stdout.trim();
    const cwd = (await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).stdout;
    const listening = (await execute('lsof', ['-nP', '-iTCP:3064', '-sTCP:LISTEN', '-Fp'])).stdout;
    assert.equal(argv, 'node --import ./test-support/native-rds-preload.mjs --import tsx src/index.ts');
    assert.ok(cwd.includes('n' + fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')));
    assert.ok(listening.split('\n').includes('p' + pid));
    process.kill(pid, 'SIGKILL');
    await until(() => bob.ws.readyState === WebSocket.CLOSED, 'lost owner socket close');
    // Default production-sized owner/client leases are 30 seconds. Let them
    // expire naturally; the test neither reads nor edits private router keys.
    await pause(31000);
    const restarted = await execute('python3', [fileURLToPath(new URL('./bff-cluster-processes.py', import.meta.url)), 'b']);
    assert.ok(restarted.stdout.includes('Started owned BFF b'));
    await until(async () => { try { return (await fetch(bases[1] + '/api/session/me')).status === 200; } catch { return false; } }, 'replacement BFF admission');
    returned = await connect(principal);
    assert.notEqual(returned.id, bob.id, 'new connection generation');
    send(returned, { service: 'call', action: 'participant-state', callId, lobbyName,
      callerId: returned.userId, userId: returned.userId, status: 'in-call', targetUserIds: [alice.userId] });
    await until(async () => {
      const history = await request(returned, `/api/calls/${callId}/chat`);
      return history.status === 200 && history.body.participants?.length === 2;
    }, 'authenticated durable call seat recovery');
    const restoredPage = await request(returned, `/api/calls/${callId}/page`);
    assert.equal(restoredPage.status, 200); assert.equal(restoredPage.body.page.id, 'cluster-work');
    assert.equal(restoredPage.body.revision, page.body.revision);
    // The new connection is a new seat: like the portal, it rejoins the huddle.
    await joinHuddle(returned, callId);
    const sent = { body: { message: await sendHuddle(alice, callId, 'After BFF replacement') } };
    await until(() => receivedHuddle(returned, sent.body.message.id), 'actual delivery to replacement owner');
    const history = await request(alice, `/api/calls/${callId}/chat`);
    assert.ok(history.body.messages.some(message => message.id === stored.body.message.id), 'crash preserves durable history');
    assert.ok(history.body.messages.some(message => message.id === sent.body.message.id));
  } finally { close(alice, bob); if (returned) close(returned); }
});

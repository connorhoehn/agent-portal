const server = { ...require('@connorhoehn/realtime-modules/server'), ...require('@connorhoehn/realtime-modules/server/stores/dynamo') };
const assert = require('assert');
(async () => {
  const sent = [];
  const client = { send: async (cmd) => { sent.push(cmd.constructor.name); return {}; } };
  const tx = new server.DynamoChatStore({ client, messageIndexWrites: 'transaction' });
  await tx.conversations.recordMessage({ channel: 'social:dm:a:b', members: ['a', 'b'], message: { id: 'm', clientId: 'c', channel: 'social:dm:a:b', message: 'hi', timestamp: new Date().toISOString() } });
  assert.deepEqual(sent, ['TransactWriteItemsCommand']);
  sent.length = 0;
  const each = new server.DynamoChatStore({ client });
  await each.conversations.recordMessage({ channel: 'social:dm:a:b', members: ['a', 'b'], message: { id: 'm', clientId: 'c', channel: 'social:dm:a:b', message: 'hi', timestamp: new Date().toISOString() } });
  assert.deepEqual(sent, ['UpdateItemCommand', 'UpdateItemCommand']);
  const redis = { command: async () => null, publish: async () => 0, subscribe: async () => async () => {} };
  assert.throws(() => new server.RedisRealtimeRouter({ redis, namespace: 'n', nodeId: 'x', peerOperationLingerMs: 2001 }), /peer operation linger/);
  new server.RedisRealtimeRouter({ redis, namespace: 'n', nodeId: 'x', peerOperationLingerMs: 500 });
  console.log('packed runtime ok 0.110.0');
})().catch(e => { console.error(e); process.exit(1); });

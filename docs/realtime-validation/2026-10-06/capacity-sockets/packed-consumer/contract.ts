import { RedisRealtimeRouter, createAuthorityScope, type RealtimeClusterRedis, type RedisRealtimeRouterOptions } from '@connorhoehn/realtime-modules/server';
import { DynamoChatStore, DynamoConversationsStore } from '@connorhoehn/realtime-modules/server/stores/dynamo';
const redis: RealtimeClusterRedis = { command: async () => null, publish: async () => 0, subscribe: async () => async () => {} };
const linger: RedisRealtimeRouterOptions['peerOperationLingerMs'] = 500;
const cluster = new RedisRealtimeRouter({ redis, namespace: 'packed', nodeId: 'one', publishProofMaxAgeMs: 2000, peerOperationLingerMs: linger });
const client = { send: async (_: unknown) => ({}) };
const store = new DynamoChatStore({ client, messageIndexWrites: 'transaction' });
const conv = new DynamoConversationsStore({ client, tableName: 't', messageIndexWrites: 'each' });
// @ts-expect-error only 'each' | 'transaction'
new DynamoChatStore({ client, messageIndexWrites: 'batch' });
void cluster; void store; void conv; void createAuthorityScope;

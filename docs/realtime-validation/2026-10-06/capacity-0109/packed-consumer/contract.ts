import { RedisRealtimeRouter, LocalRealtimeRouter, attachRealtime, revokePublishProofs, publishProofKey, PUBLISH_PROOF_SKEW_MS,
  createAuthorityScope, type RealtimeClusterRedis, type AuthorityScope } from '@connorhoehn/realtime-modules/server';
import { parseDmLobby, dmLobbyPrefix, type ParsedDmLobby } from '@connorhoehn/realtime-modules/call';
import { parseDmLobby as videoParse, dmLobbyPrefix as videoPrefix } from '@connorhoehn/realtime-modules/client/video';
const redis: RealtimeClusterRedis = { command: async () => null, publish: async () => 0, subscribe: async () => async () => {} };
const cluster = new RedisRealtimeRouter({ redis, namespace: 'packed', nodeId: 'one', publishProofMaxAgeMs: 2000 });
const local = new LocalRealtimeRouter({ publishProofMaxAgeMs: 2000 });
const maxAge: number = local.publishProofMaxAgeMs;
const scope: AuthorityScope = createAuthorityScope('chat.send');
const dropped: number = revokePublishProofs(scope, 'room');
const key: string = publishProofKey('room', 'c1');
const skew: number = PUBLISH_PROOF_SKEW_MS;
const parsed: ParsedDmLobby | null = parseDmLobby('social:dm:a:b', { prefix: 'social:' });
const prefix: string = dmLobbyPrefix({ prefix: 'social:' }) + videoPrefix();
type AttachOpts = Parameters<typeof attachRealtime>[1];
const opt: AttachOpts['publishProofMaxAgeMs'] = 2000;
void cluster; void maxAge; void dropped; void key; void skew; void parsed; void prefix; void opt; void videoParse;

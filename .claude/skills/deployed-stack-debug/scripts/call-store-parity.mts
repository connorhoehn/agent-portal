// Run the same call-state operations against realtime-modules'
// InMemoryCallStateStore (local dev) and RedisCallStateStore through the
// middleware's own Redis wrapper (the deployed shape), on a throwaway Redis
// container this script starts and removes. A difference means the deployed
// gateway behaves differently from local dev for that operation.
//
//   npx tsx call-store-parity.mts [--port 26399]
import { execFileSync } from 'node:child_process';
import { arg, mwImport, mwSource } from './lib.mts';

const port = arg('port', '26399');
const name = `claude-call-store-parity-${process.pid}`;
execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:6379`, 'redis:7-alpine'], { stdio: 'ignore' });
try {
  await new Promise(r => setTimeout(r, 1500));
  const { RedisCallStateStore, InMemoryCallStateStore } = await mwImport('@connorhoehn/realtime-modules/call');
  const { createBoundedRedis } = await mwImport('@connorhoehn/realtime-modules/server');
  const { createRedisStore } = await mwSource('src/lib/redis-store.ts');
  const transport = await createBoundedRedis(`redis://127.0.0.1:${port}`, { timeoutMs: 2000 });
  const stores: Record<string, any> = { memory: new InMemoryCallStateStore(), redis: new RedisCallStateStore(createRedisStore(transport)) };
  const lobby = 'social:room:parity', callId = 'call-parity-1';
  const steps: Array<[string, (s: any) => Promise<unknown>]> = [
    ['registerParticipant', s => s.registerParticipant(callId, 'c-owner', 'u-owner', lobby, [], lobby)],
    ['registerLobbyCall', s => s.registerLobbyCall?.(lobby, callId, 60)],
    ['getCallIdsByLobby', s => s.getCallIdsByLobby?.(lobby)],
    ['getCall', s => s.getCall?.(callId)],
    ['registerParticipant (guest)', s => s.registerParticipant(callId, 'c-guest', 'u-owner', lobby, [], lobby)],
    ['markAccepted', s => s.markAccepted?.(callId, 60)],
    ['isAccepted', s => s.isAccepted?.(callId)],
  ];
  for (const [label, step] of steps) {
    const results: Record<string, string> = {};
    for (const [storeName, store] of Object.entries(stores)) {
      try { results[storeName] = JSON.stringify(await step(store)) ?? 'undefined'; }
      catch (e) { results[storeName] = `THREW ${(e as Error).message}`; }
    }
    const same = results.memory === results.redis;
    console.log(`${same ? '  ' : '≠ '}${label}: memory=${results.memory?.slice(0, 140)}${same ? '' : `  redis=${results.redis?.slice(0, 140)}`}`);
  }
  await transport.quit();
} finally {
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
process.exit(0);

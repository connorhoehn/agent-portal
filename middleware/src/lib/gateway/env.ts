// The /ws gateway's tuning knobs, each read once at attach and validated loudly.

/** Canonical router setting, with the old main branch's explicit Redis opt-in
 * mapped to the native leased router. REDIS_URL alone never enables fan-out. */
export function realtimeGatewayRouting(env: NodeJS.ProcessEnv = process.env): 'local' | 'redis' {
  const current = (env['REALTIME_GATEWAY_ROUTER'] ?? '').trim();
  if (current) {
    if (current === 'local' || current === 'redis') return current;
    throw new Error('REALTIME_GATEWAY_ROUTER must be local or redis');
  }
  const legacy = (env['REALTIME_FANOUT'] ?? '').trim().toLowerCase();
  if (!legacy || legacy === 'off' || legacy === 'local') return 'local';
  if (legacy === 'redis') return 'redis';
  throw new Error('REALTIME_FANOUT must be redis, local or off; prefer REALTIME_GATEWAY_ROUTER');
}

/** Retained main-branch helper name; selection now uses native leased routing. */
export function realtimeFanoutRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return realtimeGatewayRouting(env) === 'redis';
}

/** REALTIME_PEER_OPERATION_LINGER_MS: 0 disables; default 500 ms, at most 2000. */
export function peerOperationLingerMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['REALTIME_PEER_OPERATION_LINGER_MS'] ?? '').trim();
  if (!raw) return 500;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 2000) throw new Error('REALTIME_PEER_OPERATION_LINGER_MS must be an integer from 0 to 2000');
  return value;
}

/** SOCIAL_CHAT_INDEX_WRITES: 'each' (default) or 'transaction' (one TransactWriteItems per message). */
export function socialChatIndexWrites(env: NodeJS.ProcessEnv = process.env): 'each' | 'transaction' {
  const raw = (env['SOCIAL_CHAT_INDEX_WRITES'] ?? '').trim();
  if (!raw || raw === 'each') return 'each';
  if (raw === 'transaction') return 'transaction';
  throw new Error("SOCIAL_CHAT_INDEX_WRITES must be 'each' or 'transaction'");
}

/** REALTIME_PUBLISH_PROOF_MAX_AGE_MS: 0 disables; default 2000 ms. */
export function publishProofMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['REALTIME_PUBLISH_PROOF_MAX_AGE_MS'] ?? '').trim();
  if (!raw) return 2000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw new Error('REALTIME_PUBLISH_PROOF_MAX_AGE_MS must be an integer from 0 to 10000');
  return value;
}

/** on/off with a production-aware default: ON outside production, OFF in
 * production until a capacity run accepts it (docs/realtime-validation/2026-10-14/capacity-r6.md). */
function switchFlag(name: string, env: NodeJS.ProcessEnv): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (!raw) return env['NODE_ENV'] !== 'production';
  if (raw === 'on' || raw === 'true' || raw === '1') return true;
  if (raw === 'off' || raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be on or off`);
}

/**
 * REALTIME_AUTHORITY_CACHE=on|off: cache POSITIVE channel verdicts per
 * (connection, channel, epoch) — realtime-modules 0.120 `withAuthorityCache`.
 * Safe only with lib/gateway/authority-invalidation.ts wired into every
 * authority write. Default on outside production, off in production.
 */
export function authorityCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return switchFlag('REALTIME_AUTHORITY_CACHE', env);
}

/** REALTIME_AUTHORITY_CACHE_MAX_AGE_MS: the backstop for a missed event (V5); default 5000, 100–60000. */
export function authorityCacheMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['REALTIME_AUTHORITY_CACHE_MAX_AGE_MS'] ?? '').trim();
  if (!raw) return 5000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) throw new Error('REALTIME_AUTHORITY_CACHE_MAX_AGE_MS must be an integer from 100 to 60000');
  return value;
}

/**
 * The per-socket inbound frame budget (realtime-modules 0.120 `inboundRateLimit`),
 * or false. REALTIME_INBOUND_RATE_LIMIT=on|off (default on outside production,
 * off in production); REALTIME_INBOUND_FPS (default 50) and
 * REALTIME_INBOUND_BURST (default 2 × fps).
 *
 * Measured 2026-10-14 (headless Chromium against dev:mock, pipelines run
 * activity graph, docs/realtime-validation/2026-10-14/authority-cache.md):
 * a cursor drag or hover sends 3.97 cursor frames/s (peak 5 in any 1 s, never
 * 2 in 100 ms); a 413 Hz synthetic pointer stream peaks at 8/s; page load
 * sends 7 frames (6 within 100 ms); typing sends one frame per 2.5 s. The
 * library default (50/s, burst 100) is over 6× the sustained peak and over
 * 14× the load burst, so it is kept.
 */
export function inboundRateLimit(env: NodeJS.ProcessEnv = process.env): false | { framesPerSecond: number; burst: number } {
  if (!switchFlag('REALTIME_INBOUND_RATE_LIMIT', env)) return false;
  const read = (name: string, fallback: number, max: number) => {
    const raw = (env[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
    return value;
  };
  const framesPerSecond = read('REALTIME_INBOUND_FPS', 50, 10_000);
  return { framesPerSecond, burst: read('REALTIME_INBOUND_BURST', framesPerSecond * 2, 20_000) };
}

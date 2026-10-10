// The /ws gateway's tuning knobs, each read once at attach and validated loudly.

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

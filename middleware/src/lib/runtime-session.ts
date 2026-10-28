import { createHash, randomUUID } from 'crypto';

/**
 * AgentCore Runtime requires runtimeSessionId to be ≥ 33 characters.
 * Normalise a caller-supplied session id: keep it when it satisfies the
 * constraint, otherwise mint a fresh compliant one (two UUIDs → 40 chars).
 *
 * Single home for the ≥33 rule — used by the AG-UI agent routes and the
 * devbox routes. Do not duplicate the constant elsewhere.
 */
export const RUNTIME_SESSION_ID_MIN_LENGTH = 33;

export function normalizeRuntimeSessionId(raw?: string | null): string {
  if (raw && raw.length >= RUNTIME_SESSION_ID_MIN_LENGTH) return raw;
  return randomUUID() + randomUUID().slice(0, 4);
}

/**
 * The runtime (microVM) session for one user's conversation. The client picks
 * the conversation id, so routing on it directly let anyone who learned or
 * guessed another user's id continue THEIR runtime session, with its
 * in-memory state. Hashing the owner in keeps one runtime per user per
 * conversation; the client-facing id (Memory, traces, RUN_STARTED) is
 * unchanged. 64 hex chars, inside the >=33 rule.
 */
export function scopedRuntimeSessionId(owner: string | null, conversationId: string): string {
  return createHash('sha256').update(`${owner ?? 'anonymous'}\n${conversationId}`).digest('hex');
}

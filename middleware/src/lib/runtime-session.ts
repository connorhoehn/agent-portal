import { randomUUID } from 'crypto';

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

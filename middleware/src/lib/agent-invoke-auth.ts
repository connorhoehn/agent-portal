// Sign the caller identity the middleware hands an agent on invoke.
//
// Every invoke payload that carries an `auth` block ({sub, role, tenant,
// actor?}) gets `authSig`: the service envelope (service-http-v1, the HMAC the
// agents' callbacks already use) over that block and the conversation id it
// belongs to. The supervisor verifies it (agents/_shared/invoke_auth.py) before
// it picks a guardrail or derives a sub-agent session from it; an unsigned or
// forged block counts as the least-privileged caller. The canonical body is
// built identically on both sides: `{"auth":{...string fields, sorted...},
// "conversationId":"..."}` with no spaces.
//
// The secret is AGENT_INVOKE_SECRET (infra mints `<prefix>-agent-invoke-secret`
// and gives it to this task and the supervisor runtime). Unset, nothing is
// signed: a dev process talking to a dev agent keeps working through the
// agent's INSECURE_DEV_MODE path, and a deployed agent refuses the block.

import { signServiceRequest } from '@connorhoehn/service-runtime';

export const AGENT_INVOKE_SECRET_ENV = 'AGENT_INVOKE_SECRET';
export const AGENT_INVOKE_AUDIENCE = 'orgiq-agent/invoke-auth';
export const AGENT_INVOKE_SERVICE_ID = 'orgiq-middleware';
const METHOD = 'POST';
const TARGET = '/invocations';

/** The exact string both sides sign and verify. */
export function canonicalInvokeAuth(auth: Record<string, unknown>, conversationId: string): string {
  const fields: Record<string, string> = {};
  for (const key of Object.keys(auth).sort()) {
    const value = auth[key];
    if (typeof value === 'string') fields[key] = value;
  }
  return JSON.stringify({ auth: fields, conversationId: conversationId ?? '' });
}

/** `authSig` for this block, or null when no secret is configured. */
export function signInvokeAuth(
  auth: Record<string, unknown>,
  conversationId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = (env[AGENT_INVOKE_SECRET_ENV] ?? '').trim();
  if (!secret) return null;
  return signServiceRequest(
    { method: METHOD, target: TARGET, body: canonicalInvokeAuth(auth, conversationId ?? '') },
    { secret, serviceId: AGENT_INVOKE_SERVICE_ID, audience: AGENT_INVOKE_AUDIENCE },
  );
}

/**
 * The fields to spread into an invoke body: the auth block the agent will read
 * (the payload's, else the structured input's) and its signature.
 */
export function signedAuthFields(
  payload: { auth?: Record<string, unknown>; structuredInput?: Record<string, unknown>; sessionId?: string },
): { auth?: Record<string, unknown>; authSig?: string } {
  const fromStructured = payload.structuredInput?.['auth'];
  const auth = payload.auth
    ?? (fromStructured && typeof fromStructured === 'object' ? fromStructured as Record<string, unknown> : undefined);
  if (!auth) return {};
  const sig = signInvokeAuth(auth, payload.sessionId);
  return sig ? { auth, authSig: sig } : { auth };
}

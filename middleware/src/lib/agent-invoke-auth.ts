// Sign the caller identity the middleware hands an agent on invoke.
//
// Every invoke payload that carries an `auth` block ({sub, role, tenant,
// actor?}) gets `authSig`: the service envelope (service-http-v1, the HMAC the
// agents' callbacks already use) over that block and the conversation id it
// belongs to. Every agent that reads the caller's tenant or role verifies it
// (agents/_shared/invoke_auth.py): the supervisor before it picks a guardrail,
// the read agents before they pick a retrieval tenant, the assessment agents
// for their tenant floor. An unsigned or forged block counts as the
// least-privileged caller. The canonical body is
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
 * The top-level invoke-body keys the agents read as identity or as the trace
 * join (agents/_shared/invoke_auth.py, instrumentation.py, agui_stream.py). The
 * body builder below sets them and nothing else may: caller input never
 * carries them, and the structured input never reaches the top level.
 */
export const INVOKE_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'auth', 'authSig', 'tenant', 'sub', 'role', 'actor',
  'userId', 'user_id', 'sessionId', 'session_id', 'runtimeSessionId',
  'runId', 'run_id', 'invocationId', 'parentInvocationId', 'parent_invocation_id',
  'threadId', 'thread_id',
]);

/** The keys the body builder owns besides identity: the prompt, the history, the stream flag and the nested input. */
export const INVOKE_BODY_KEYS: ReadonlySet<string> = new Set([
  ...INVOKE_IDENTITY_KEYS, 'message', 'prompt', 'input_text', 'history', 'stream', 'input',
]);

export interface InvokeBodyPayload {
  message: string;
  structuredInput?: Record<string, unknown>;
  sessionId?: string;
  runId?: string;
  userId?: string;
  auth?: Record<string, unknown>;
  history?: { role: string; content: string }[];
}

/**
 * The JSON body an agent runtime is invoked with. The structured input goes
 * under `input`, never spread at the top level, with every identity key
 * removed (a trusted caller's `auth` is lifted out and signed; its `run_id`
 * becomes the body's `runId`). Identity is set last, so nothing nested or
 * earlier in the object can shadow it. Agents read their structured fields
 * from `input` (agents/_shared/invoke_auth.py `request_fields`) and identity
 * only from the verified `auth` block.
 */
export function buildInvokeBody(payload: InvokeBodyPayload, opts: { stream?: boolean } = {}): Record<string, unknown> {
  const structured = payload.structuredInput ?? {};
  const input = Object.fromEntries(Object.entries(structured).filter(([k]) => !INVOKE_BODY_KEYS.has(k)));
  const structuredRun = structured['run_id'];
  const runId = payload.runId ?? (typeof structuredRun === 'string' && structuredRun ? structuredRun : undefined);
  return {
    ...(Object.keys(input).length ? { input } : {}),
    message: payload.message,
    prompt: payload.message,
    input_text: payload.message,
    ...(opts.stream ? { stream: true } : {}),
    ...(payload.history?.length ? { history: payload.history } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
    // The caller identity, signed for the agent to verify.
    ...signedAuthFields(payload),
  };
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

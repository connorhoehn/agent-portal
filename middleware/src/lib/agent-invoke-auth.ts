// Sign the caller identity the middleware hands an agent on invoke.
//
// Every invoke payload that carries an `auth` block ({sub, role, tenant,
// actor?}) gets `authSig`: the service envelope (service-http-v1, the HMAC the
// agents' callbacks already use) over that block and the conversation id it
// belongs to. Every agent that reads the caller's tenant or role verifies it
// (agents/_shared/invoke_auth.py): the supervisor before it picks a guardrail,
// the read agents before they pick a retrieval tenant, the assessment agents
// for their tenant floor. An unsigned or forged block counts as the
// least-privileged caller.
//
// The signature also binds what is asked, so a captured auth block cannot be
// replayed with a different prompt inside its 300 s window: the SHA-256 of the
// prompt, of the structured input (sent as JSON text so both sides hash the
// same bytes), of the history (as [role, content] pairs), and the run id. The
// canonical body is built identically on both sides, sorted keys, no spaces:
// `{"auth":{...string fields...},"conversationId":"...","historySha256":"...",
// "inputSha256":"...","nonce":"...","promptSha256":"...","runId":"..."}` (an
// absent input or history hashes as "", an absent run id is "").
//
// Every signed body also carries a fresh random `authNonce`, bound into the
// signature, and the agents accept each nonce once inside the window
// (invoke_auth.py `ReplayCache`), so the identical request sent twice is
// refused the second time. The agent-side cache is in-process; a runtime with
// several replicas behind one endpoint needs a shared store for it.
//
// The secret is AGENT_INVOKE_SECRET (infra mints `<prefix>-agent-invoke-secret`
// and gives it to this task and the supervisor runtime). Unset, nothing is
// signed: a dev process talking to a dev agent keeps working through the
// agent's INSECURE_DEV_MODE path, and a deployed agent refuses the block.

import { createHash, randomBytes } from 'node:crypto';
import { signServiceRequest } from '@connorhoehn/service-runtime';

export const AGENT_INVOKE_SECRET_ENV = 'AGENT_INVOKE_SECRET';
export const AGENT_INVOKE_AUDIENCE = 'orgiq-agent/invoke-auth';
export const AGENT_INVOKE_SERVICE_ID = 'orgiq-middleware';
const METHOD = 'POST';
const TARGET = '/invocations';

/** What the signed identity is asking: bound into the signature. */
export interface InvokeBinding {
  prompt: string;
  /** The structured input exactly as sent (JSON text), when there is one. */
  input?: string;
  history?: ReadonlyArray<{ role: string; content: string }>;
  runId?: string;
  /** One-use value the agent's replay cache keys on (sent as `authNonce`). */
  nonce?: string;
}

/** A fresh nonce for one invoke: 18 random bytes, 24 url-safe characters. */
export const newInvokeNonce = (): string => randomBytes(18).toString('base64url');

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The exact string both sides sign and verify. */
export function canonicalInvokeAuth(auth: Record<string, unknown>, conversationId: string, binding: InvokeBinding = { prompt: '' }): string {
  const fields: Record<string, string> = {};
  for (const key of Object.keys(auth).sort()) {
    const value = auth[key];
    if (typeof value === 'string') fields[key] = value;
  }
  const history = binding.history?.length ? sha256(JSON.stringify(binding.history.map((h) => [h.role, h.content]))) : '';
  return JSON.stringify({
    auth: fields,
    conversationId: conversationId ?? '',
    historySha256: history,
    inputSha256: binding.input ? sha256(binding.input) : '',
    nonce: binding.nonce ?? '',
    promptSha256: sha256(binding.prompt ?? ''),
    runId: binding.runId ?? '',
  });
}

/** `authSig` for this block, or null when no secret is configured. */
export function signInvokeAuth(
  auth: Record<string, unknown>,
  conversationId: string | undefined,
  binding: InvokeBinding = { prompt: '' },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = (env[AGENT_INVOKE_SECRET_ENV] ?? '').trim();
  if (!secret) return null;
  return signServiceRequest(
    { method: METHOD, target: TARGET, body: canonicalInvokeAuth(auth, conversationId ?? '', binding) },
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
  'auth', 'authSig', 'authNonce', 'tenant', 'sub', 'role', 'actor',
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
  // JSON text, so the agent hashes exactly the bytes that were signed.
  const inputText = Object.keys(input).length ? JSON.stringify(input) : undefined;
  const binding: InvokeBinding = {
    prompt: payload.message,
    ...(inputText ? { input: inputText } : {}),
    ...(payload.history?.length ? { history: payload.history } : {}),
    ...(runId ? { runId } : {}),
  };
  return {
    ...(inputText ? { input: inputText } : {}),
    message: payload.message,
    prompt: payload.message,
    input_text: payload.message,
    ...(opts.stream ? { stream: true } : {}),
    ...(payload.history?.length ? { history: payload.history } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(runId ? { runId } : {}),
    ...(payload.userId ? { userId: payload.userId } : {}),
    // The caller identity, signed with what it asks for the agent to verify.
    ...signedAuthFields(payload, binding),
  };
}

/**
 * The fields to spread into an invoke body: the auth block the agent will read
 * (the payload's, else the structured input's) and its signature.
 */
export function signedAuthFields(
  payload: { auth?: Record<string, unknown>; structuredInput?: Record<string, unknown>; sessionId?: string },
  binding: InvokeBinding = { prompt: '' },
): { auth?: Record<string, unknown>; authSig?: string; authNonce?: string } {
  const fromStructured = payload.structuredInput?.['auth'];
  const auth = payload.auth
    ?? (fromStructured && typeof fromStructured === 'object' ? fromStructured as Record<string, unknown> : undefined);
  if (!auth) return {};
  const nonce = binding.nonce ?? newInvokeNonce();
  const sig = signInvokeAuth(auth, payload.sessionId, { ...binding, nonce });
  return sig ? { auth, authSig: sig, authNonce: nonce } : { auth };
}

// Every OpenAI-specific shape of the voice navigator lives here
// (docs/voice-navigator-spec.md §1, "What this changes for P2/P3"). The shapes
// are the ones package V1 pinned against the real Live API on 8 November 2026
// (docs/voice/live-events.jsonl); a change in the wire format changes this
// file and nothing else.
//
//   POST {base}/live/sessions  { session, transport: { type: 'webrtc', sdp: <offer> } }
//     -> 201 { session: { id: 'live_…' }, transport: { type: 'webrtc', sdp: <answer> } }
//     There is no ephemeral client secret: the middleware proxies the offer
//     and the answer, and the browser never holds a credential.
//   POST {base}/live/sessions/{id}/hangup -> 200 {} (ends a session in any state)
//   WSS  {base}/live/sessions/{id}/attach  the sideband: the provider's own usage
//     figures for the session, read by the middleware (G12, below)
//   session = {
//     model, instructions (<= 20,000 chars), audio?: { output: { voice } },
//     delegation?: { type: 'responses', responses: { model, instructions, tools: [strict function tools],
//                    tool_choice: 'auto', parallel_tool_calls: false } },
//     client: { data_channel: { allowed_client_events, allowed_server_events } },
//   }
//   Tools go ONLY under delegation.responses.tools: a plain session.tools is
//   refused with unknown_parameter. The data-channel allowlist leaves out
//   session.update and session.instructions.append, so the browser cannot swap
//   the backend model, the tools or the instructions mid-session (§2).
//
// OPENAI_API_KEY is read only here, and a REPLACE_ME placeholder counts as
// unset (the securityPreconditions pattern, lib/runtime-profile.ts). The key
// never leaves this module: it is not in a return value, an error or a log line.

import type { ResponsesFunctionTool } from './catalogue.js';

function apiKey(): string | null {
  const v = (process.env['OPENAI_API_KEY'] ?? '').trim();
  return v && !v.includes('REPLACE_ME') ? v : null;
}

function apiBase(): string {
  return ((process.env['OPENAI_BASE_URL'] ?? '').trim() || 'https://api.openai.com/v1').replace(/\/$/, '');
}

/** Whether a real session can be minted (a key is configured). */
export function voiceProviderConfigured(): boolean {
  return apiKey() != null;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init);
/** Tests: replace the transport. */
export function _setVoiceFetch(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

export interface LiveSessionInput {
  model: string;
  /** What the voice is told (the front model). */
  instructions: string;
  /** What the delegation backend is told (delegation.responses.instructions). */
  delegationInstructions: string;
  voice: string | null;
  /** Null = no delegation: the voice answers, every tool call is refused (§8). */
  delegationModel: string | null;
  tools: readonly ResponsesFunctionTool[];
}

/**
 * The client events the browser's data channel may send (§1, the probe's
 * list). Never session.update or session.instructions.append.
 */
export const ALLOWED_CLIENT_EVENTS = [
  'session.close', 'session.input_audio.mute', 'session.input_audio.unmute',
  'response.item.create', 'response.create', 'session.thinking.append', 'session.commentary.append',
] as const;

/** The server events the data channel delivers (§1, the probe's list). */
export const ALLOWED_SERVER_EVENTS: ReadonlyArray<{ type: string; response_event?: string }> = [
  { type: 'session.started' }, { type: 'session.closed' }, { type: 'session.usage.updated' },
  { type: 'session.input_transcript.delta' }, { type: 'session.output_transcript.delta' },
  { type: 'session.delegation.created' }, { type: 'session.input_audio.muted' }, { type: 'session.input_audio.unmuted' },
  { type: 'session.thinking.appended' }, { type: 'session.commentary.appended' }, { type: 'error' }, { type: 'info' },
  { type: 'response.event', response_event: 'response.created' },
  { type: 'response.event', response_event: 'response.output_item.done' },
  { type: 'response.event', response_event: 'response.completed' },
  { type: 'response.event', response_event: 'response.failed' },
];

/** Keywords left out of a strict schema: the dock enforces them; the probe never sent them under strict. */
const UNSTRICT_KEYWORDS = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']);

/**
 * A catalogue schema in the strict form Responses function calling takes:
 * every property required (an optional one becomes nullable, so the model
 * sends null for "not given"), additionalProperties false at every level.
 * The dock validates the call against the catalogue's own schema after
 * dropping nulls.
 */
export function strictSchema(schema: Record<string, unknown>, nullable = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) if (!UNSTRICT_KEYWORDS.has(k)) out[k] = v;
  if (schema['type'] === 'object' && schema['properties'] && typeof schema['properties'] === 'object') {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const required = new Set((schema['required'] as string[] | undefined) ?? []);
    out['properties'] = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, strictSchema(v, !required.has(k))]));
    out['required'] = Object.keys(props);
    out['additionalProperties'] = false;
  }
  if (schema['type'] === 'array' && schema['items'] && typeof schema['items'] === 'object') {
    out['items'] = strictSchema(schema['items'] as Record<string, unknown>);
  }
  if (nullable && typeof out['type'] === 'string') {
    out['type'] = [out['type'], 'null'];
    if (Array.isArray(out['enum'])) out['enum'] = [...(out['enum'] as unknown[]), null];
  }
  return out;
}

/** One catalogue function as a delegation tool: `{ type: 'function', name, description, parameters, strict: true }`. */
export function liveFunctionTool(t: ResponsesFunctionTool): Record<string, unknown> {
  return {
    type: 'function', name: t.name, description: t.description,
    parameters: strictSchema(t.parameters as unknown as Record<string, unknown>), strict: true,
  };
}

/** The `session` object of the create call (§1 "What this changes for P2/P3"). */
export function liveSessionBody(input: LiveSessionInput): Record<string, unknown> {
  const session: Record<string, unknown> = { model: input.model, instructions: input.instructions.slice(0, 20_000) };
  if (input.voice && /^voice_[\w-]{4,80}$/.test(input.voice)) session['audio'] = { output: { voice: { id: input.voice } } };
  else if (input.voice && /^[a-z]{2,20}$/.test(input.voice)) session['audio'] = { output: { voice: input.voice } };
  if (input.delegationModel && input.tools.length > 0) {
    session['delegation'] = {
      type: 'responses',
      responses: {
        model: input.delegationModel, instructions: input.delegationInstructions.slice(0, 20_000),
        tools: input.tools.map(liveFunctionTool), tool_choice: 'auto', parallel_tool_calls: false,
      },
    };
  }
  session['client'] = {
    data_channel: {
      allowed_client_events: [...ALLOWED_CLIENT_EVENTS],
      allowed_server_events: ALLOWED_SERVER_EVENTS.map((e) => ({ ...e })),
    },
  };
  return session;
}

/** A refusal from the live API; carries the status only, never the upstream body. */
export class VoiceProviderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Mint one session: forward the browser's SDP offer, return the answer and the provider's session id. */
export async function createLiveSession(sdp: string, input: LiveSessionInput): Promise<{ providerSessionId: string | null; sdp: string }> {
  const key = apiKey();
  if (!key) throw new VoiceProviderError(503, 'no OpenAI key configured');
  const res = await fetchImpl(`${apiBase()}/live/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: liveSessionBody(input), transport: { type: 'webrtc', sdp } }),
  });
  const text = await res.text();
  if (!res.ok) throw new VoiceProviderError(res.status, `live session create answered ${res.status}`);
  let body: { session?: { id?: unknown }; transport?: { sdp?: unknown } };
  try { body = JSON.parse(text) as typeof body; } catch { throw new VoiceProviderError(502, 'live session create answered non-JSON'); }
  const answer = body.transport?.sdp;
  if (typeof answer !== 'string' || !answer.startsWith('v=0')) throw new VoiceProviderError(502, 'live session create carried no SDP answer');
  const id = body.session?.id;
  return { providerSessionId: typeof id === 'string' && /^[\w-]{1,200}$/.test(id) ? id : null, sdp: answer };
}

/** Stop a session that may still be billing (the dock is gone, or the reaper). Best-effort; true when the API accepted it. */
export async function hangupLiveSession(providerSessionId: string): Promise<boolean> {
  const key = apiKey();
  if (!key || !/^[\w-]{1,200}$/.test(providerSessionId)) return false;
  try {
    const res = await fetchImpl(`${apiBase()}/live/sessions/${providerSessionId}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The sideband (docs/voice-navigator-gaps.md §2.4, G12; spec §1 "Sideband").
//
//   wss://api.openai.com/v1/live/sessions/{id}/attach   Authorization: Bearer <key>
//     attaches to a minted WebRTC session at once, before media connects, and
//     receives the session's server events (V1, `mint-webrtc`):
//       session.started        { session }                         (ignored here)
//       session.usage.updated  { usage: { seconds }, context_window }   cumulative
//       session.closed         { reason, usage: { seconds } }           final, cumulative
//       response.event         { delegation_id, event: { type: 'response.completed',
//                                response: { id, usage: { input_tokens, output_tokens,
//                                input_tokens_details: { cached_tokens } } } } }
//     Seconds are cumulative, never summed; tokens are summed per nested
//     response, each response id counted once.
//
// One socket per live session, held by the process that minted it. Best
// effort: attaching never throws, never blocks the mint, reconnects at most
// twice after an unexpected close, and the socket is closed by the session's
// close, the reaper, or its own lifetime. The key stays in this module: it is
// in the constructor's header and nowhere else.

/** What the provider itself reported for one live session. */
export interface ProviderUsage {
  /** The latest cumulative `usage.seconds`; null until the first usage frame. */
  seconds: number | null;
  /** Sums of every nested `response.completed.response.usage`; null until one arrived (0 once the session closed with none). */
  inputTokens: number | null;
  outputTokens: number | null;
  /** `input_tokens_details.cached_tokens`, a part of inputTokens. */
  cachedTokens: number | null;
  /** How many distinct responses the sums cover. */
  responses: number;
  /** `session.closed` arrived: the figures are the session's final ones. */
  final: boolean;
}

/** The part of a WebSocket the sideband uses (Node 22's built-in, or a test's fake). */
export interface SidebandSocket {
  close(code?: number, reason?: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: any) => void): void;
}
/** Node's WebSocket takes `{ headers }` as its second argument (undici's WebSocketInit). */
export type SidebandSocketCtor = new (url: string, init: { headers: Record<string, string> }) => SidebandSocket;

const builtinSocket = (): SidebandSocketCtor | null =>
  ((globalThis as { WebSocket?: unknown }).WebSocket as SidebandSocketCtor | undefined) ?? null;
let socketCtor: () => SidebandSocketCtor | null = builtinSocket;
/** Tests: replace the WebSocket constructor (null = the built-in one). */
export function _setVoiceWebSocket(ctor: SidebandSocketCtor | null): void {
  socketCtor = ctor ? () => ctor : builtinSocket;
}

/** Reconnects after an unexpected close, on top of the first connect. */
export const SIDEBAND_MAX_RECONNECTS = 2;
/** The socket's longest life when nothing closes it (the mint passes its hold's life plus a margin). */
const SIDEBAND_DEFAULT_LIFETIME_MS = 2 * 60 * 60_000;

interface Sideband {
  providerSessionId: string;
  socket: SidebandSocket | null;
  usage: ProviderUsage;
  seenResponses: Set<string>;
  connected: boolean;
  connects: number;
  /** Detached, final, or out of reconnects: nothing more will arrive. */
  ended: boolean;
  onUsage?: (usage: ProviderUsage) => void | Promise<void>;
  onEvent?: (event: SidebandEvent) => void;
  waiters: Array<() => void>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const sidebands = new Map<string, Sideband>();

/**
 * The socket's own life, for the session's event log (lib/voice/session-log.ts):
 * connected, lost (and whether it will retry), the provider's `session.closed`
 * (its reason code only), detached. Never a frame's content.
 */
export type SidebandEvent =
  | { state: 'connected'; connects: number }
  | { state: 'lost'; retry: boolean; connects: number }
  | { state: 'closed'; reason: string | null }
  | { state: 'detached' };

function tell(sb: Sideband, event: SidebandEvent): void {
  try { sb.onEvent?.(event); } catch { /* a sink that throws is the sink's problem, never the socket's */ }
}

const snapshot = (sb: Sideband): ProviderUsage => ({ ...sb.usage });

function later(sb: Sideband, ms: number, fn: () => void): void {
  const t = setTimeout(() => { sb.timers.delete(t); fn(); }, ms);
  (t as { unref?: () => void }).unref?.();
  sb.timers.add(t);
}

function wake(sb: Sideband): void {
  for (const w of sb.waiters.splice(0)) w();
}

function emitUsage(sb: Sideband): void {
  if (!sb.onUsage) return;
  try {
    void Promise.resolve(sb.onUsage(snapshot(sb))).catch((err: Error) => {
      console.warn(`[voice] sideband usage write failed: ${String(err?.message ?? err).slice(0, 120)}`);
    });
  } catch { /* a sink that throws is the sink's problem, never the socket's */ }
}

const tokenCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Fold one server frame into the session's figures. True when they changed. */
function onFrame(sb: Sideband, ev: Record<string, unknown>): boolean {
  const type = ev['type'];
  let changed = false;
  if (type === 'session.usage.updated' || type === 'session.closed') {
    const sec = (ev['usage'] as { seconds?: unknown } | undefined)?.seconds;
    if (typeof sec === 'number' && Number.isFinite(sec) && sec >= 0 && (sb.usage.seconds == null || sec > sb.usage.seconds)) {
      sb.usage.seconds = sec;
      changed = true;
    }
    if (type === 'session.closed') {
      sb.usage.final = true;
      sb.usage.inputTokens ??= 0; sb.usage.outputTokens ??= 0; sb.usage.cachedTokens ??= 0;
      changed = true;
    }
  }
  // The nested form is what V1 recorded; a bare response.completed is accepted too.
  const nested = type === 'response.event' ? ev['event'] as Record<string, unknown> | undefined : ev;
  if (nested && nested['type'] === 'response.completed') {
    const response = nested['response'] as { id?: unknown; usage?: Record<string, unknown> } | undefined;
    const id = typeof response?.id === 'string' ? response.id : null;
    const usage = response?.usage;
    if (usage && typeof usage === 'object' && !(id && sb.seenResponses.has(id))) {
      if (id) sb.seenResponses.add(id);
      const details = usage['input_tokens_details'] as { cached_tokens?: unknown } | undefined;
      sb.usage.inputTokens = (sb.usage.inputTokens ?? 0) + tokenCount(usage['input_tokens']);
      sb.usage.outputTokens = (sb.usage.outputTokens ?? 0) + tokenCount(usage['output_tokens']);
      sb.usage.cachedTokens = (sb.usage.cachedTokens ?? 0) + tokenCount(details?.cached_tokens);
      sb.usage.responses += 1;
      changed = true;
    }
  }
  return changed;
}

function connect(sb: Sideband): void {
  const key = apiKey();
  const Ctor = socketCtor();
  if (sb.ended) return;
  if (!key || !Ctor) { sb.ended = true; wake(sb); return; }
  sb.connects += 1;
  const url = `${apiBase().replace(/^http/, 'ws')}/live/sessions/${encodeURIComponent(sb.providerSessionId)}/attach`;
  let socket: SidebandSocket;
  try {
    socket = new Ctor(url, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    retry(sb);
    return;
  }
  sb.socket = socket;
  let gone = false;
  const lost = () => {
    if (gone) return;
    gone = true;
    if (sb.socket === socket) sb.socket = null;
    if (sb.usage.final || sb.ended) { sb.ended = true; wake(sb); return; }
    tell(sb, { state: 'lost', retry: sb.connects <= SIDEBAND_MAX_RECONNECTS, connects: sb.connects });
    retry(sb);
  };
  socket.addEventListener('open', () => { sb.connected = true; tell(sb, { state: 'connected', connects: sb.connects }); });
  socket.addEventListener('message', (msg: { data?: unknown }) => {
    let ev: unknown;
    try {
      const data = msg?.data;
      ev = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8'));
    } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    const wasFinal = sb.usage.final;
    if (onFrame(sb, ev as Record<string, unknown>)) emitUsage(sb);
    if (sb.usage.final && !wasFinal) {
      const reason = (ev as Record<string, unknown>)['reason'];
      tell(sb, { state: 'closed', reason: typeof reason === 'string' && /^[\w.-]{1,40}$/.test(reason) ? reason : null });
    }
    if (sb.usage.final) {
      sb.ended = true;
      wake(sb);
      try { socket.close(1000); } catch { /* already closing */ }
    }
  });
  socket.addEventListener('error', lost);
  socket.addEventListener('close', lost);
}

function retry(sb: Sideband): void {
  if (sb.ended || sb.connects > SIDEBAND_MAX_RECONNECTS) {
    sb.ended = true;
    wake(sb);
    return;
  }
  later(sb, 500 * sb.connects, () => connect(sb));
}

/**
 * Attach the sideband to a freshly minted live session (G12). Never throws
 * and never waits: false when it could not even start (no key, no
 * WebSocket, a malformed id, MOCK_VOICE). `onUsage` hears every change of
 * the figures; its failures are logged and dropped. `onEvent` hears the
 * socket's own life (SidebandEvent), for the session's event log.
 */
export function attachSideband(providerSessionId: string, opts: {
  onUsage?: (usage: ProviderUsage) => void | Promise<void>; onEvent?: (event: SidebandEvent) => void; lifetimeMs?: number;
} = {}): boolean {
  try {
    if (process.env['MOCK_VOICE'] === '1' || !apiKey() || !socketCtor() || !/^[\w-]{1,200}$/.test(providerSessionId)) return false;
    if (sidebands.has(providerSessionId)) return true;
    const sb: Sideband = {
      providerSessionId, socket: null, seenResponses: new Set(), connected: false, connects: 0, ended: false,
      usage: { seconds: null, inputTokens: null, outputTokens: null, cachedTokens: null, responses: 0, final: false },
      waiters: [], timers: new Set(), ...(opts.onUsage ? { onUsage: opts.onUsage } : {}), ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    };
    sidebands.set(providerSessionId, sb);
    later(sb, opts.lifetimeMs ?? SIDEBAND_DEFAULT_LIFETIME_MS, () => detachSideband(providerSessionId));
    connect(sb);
    return true;
  } catch {
    return false;
  }
}

/** The figures this process holds for a session: null when it has no sideband or the socket never opened. */
export function sidebandUsage(providerSessionId: string): ProviderUsage | null {
  const sb = sidebands.get(providerSessionId);
  return sb && sb.connected ? snapshot(sb) : null;
}

/**
 * Wait up to `ms` for the session's final figures (`session.closed`) on its
 * sideband, then answer what it holds (sidebandUsage). Returns at once when
 * there is no sideband here, it never connected, or nothing more can arrive.
 */
export async function waitForSidebandUsage(providerSessionId: string, ms: number): Promise<ProviderUsage | null> {
  const found = sidebands.get(providerSessionId);
  if (!found) return null;
  const sb: Sideband = found;
  if (!sb.ended && !sb.usage.final && sb.connected) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      (t as { unref?: () => void }).unref?.();
      function done() { clearTimeout(t); const i = sb.waiters.indexOf(done); if (i >= 0) sb.waiters.splice(i, 1); resolve(); }
      sb.waiters.push(done);
    });
  }
  return sidebandUsage(providerSessionId);
}

/** Close the session's sideband and forget it (the close route, the reaper, the lifetime). */
export function detachSideband(providerSessionId: string): void {
  const sb = sidebands.get(providerSessionId);
  if (!sb) return;
  sidebands.delete(providerSessionId);
  sb.ended = true;
  if (sb.connected) tell(sb, { state: 'detached' });
  for (const t of sb.timers) clearTimeout(t);
  sb.timers.clear();
  const socket = sb.socket;
  sb.socket = null;
  if (socket) { try { socket.close(1000); } catch { /* already closed */ } }
  wake(sb);
}

/**
 * The reaper's path (G12): hang the session up, then read its final usage
 * from the same sideband (V1: a hangup with the sideband open delivers
 * `session.closed { usage }` on it). Null usage when this process holds no
 * connected sideband for it.
 */
export async function hangupAndReadUsage(providerSessionId: string, waitMs: number): Promise<{ hungUp: boolean; usage: ProviderUsage | null }> {
  const hungUp = await hangupLiveSession(providerSessionId);
  const usage = await waitForSidebandUsage(providerSessionId, waitMs);
  return { hungUp, usage };
}

/** Tests: drop every sideband this process holds. */
export function _resetSidebands(): void {
  for (const id of [...sidebands.keys()]) detachSideband(id);
}

/** One data-channel frame of the scripted session, `atMs` after the dock starts it. */
export interface MockLiveFrame { atMs: number; event: Record<string, unknown> }

/**
 * MOCK_VOICE's scripted session (§6, §8), frame for frame in the Live shapes
 * V1 recorded (docs/voice/live-events.jsonl, session `live-responses`), so the
 * dock's runner sees what a real session sends:
 *   onStart          session.started, the user's words, session.delegation.created,
 *                    the nested response.event envelopes ending in
 *                    response.output_item.done with the function_call item
 *                    (call_id, name, arguments as a JSON string), then the
 *                    nested response.completed (output always []);
 *   onResponseCreate after the dock's function_call_output + response.create:
 *                    a new nested response under the same delegation_id and the
 *                    spoken summary;
 *   onClose          after the dock's session.close: session.closed with the
 *                    cumulative usage.seconds.
 */
export function mockLiveScript(sessionId: string, call: { name: string; arguments: Record<string, unknown>; said: string }): {
  onStart: MockLiveFrame[]; onResponseCreate: MockLiveFrame[]; onClose: MockLiveFrame[];
} {
  const live = `live_mock_${sessionId.replace(/[^0-9a-f]/g, '').slice(0, 24)}`;
  const delegationId = 'item_mock_delegation_1';
  const resp1 = 'resp_mock_1', resp2 = 'resp_mock_2', fc = 'fc_mock_1', callId = 'call_mock_1';
  const args = JSON.stringify(call.arguments);
  const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: delegationId, event });
  return {
    onStart: [
      { atMs: 0, event: { type: 'session.started', session: { id: live, model: 'gpt-live-1', status: 'active' } } },
      { atMs: 400, event: { type: 'session.input_transcript.delta', delta: call.said, start_ms: 0, end_ms: 1800 } },
      { atMs: 500, event: { type: 'session.delegation.created', offset_ms: 1900, delegation: { id: delegationId, type: 'delegation', response_id: resp1, target: 'responses' } } },
      { atMs: 510, event: env({ type: 'response.created', response: { id: resp1, status: 'in_progress', output: [] } }) },
      { atMs: 900, event: env({ type: 'response.output_item.added', item: { id: fc, type: 'function_call', status: 'in_progress', arguments: '', call_id: callId, name: call.name }, output_index: 0, sequence_number: 2 }) },
      { atMs: 1000, event: env({ type: 'response.function_call_arguments.done', arguments: args, item_id: fc, output_index: 0, sequence_number: 3 }) },
      { atMs: 1010, event: env({ type: 'response.output_item.done', item: { id: fc, type: 'function_call', status: 'completed', arguments: args, call_id: callId, name: call.name }, output_index: 0, sequence_number: 4 }) },
      { atMs: 1050, event: env({ type: 'response.completed', response: { id: resp1, status: 'completed', output: [], usage: { input_tokens: 1060, output_tokens: 20 } } }) },
      { atMs: 1200, event: { type: 'session.usage.updated', usage: { seconds: 5 } } },
    ],
    onResponseCreate: [
      { atMs: 150, event: env({ type: 'response.created', response: { id: resp2, status: 'in_progress', output: [] } }) },
      { atMs: 400, event: env({ type: 'response.completed', response: { id: resp2, status: 'completed', output: [], usage: { input_tokens: 1194, output_tokens: 28 } } }) },
      { atMs: 900, event: { type: 'session.output_transcript.delta', delta: 'Here is what I found.', start_ms: 3000, end_ms: 4200 } },
      { atMs: 1000, event: { type: 'session.usage.updated', usage: { seconds: 9 } } },
    ],
    onClose: [
      { atMs: 100, event: { type: 'session.closed', reason: 'close_requested', session: { id: live }, usage: { seconds: 15 } } },
    ],
  };
}

/** The answer a MOCK_VOICE mint returns: a syntactically valid SDP the scripted dock never applies. */
export const MOCK_SDP_ANSWER = [
  'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=mock-voice', 't=0 0', 'a=group:BUNDLE 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=inactive', '',
].join('\r\n');

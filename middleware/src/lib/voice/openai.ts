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
const UNSTRICT_KEYWORDS = new Set(['minLength', 'maxLength', 'minimum', 'maximum']);

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

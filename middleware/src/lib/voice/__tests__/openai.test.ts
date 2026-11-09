// The Live API shapes lib/voice/openai.ts sends and scripts, against what V1
// recorded (docs/voice-navigator-spec.md §1 "What this changes for P2/P3",
// docs/voice/live-events.jsonl).

import AjvImport from 'ajv';
import {
  liveSessionBody, liveFunctionTool, strictSchema, mockLiveScript, ALLOWED_CLIENT_EVENTS, createLiveSession, _setVoiceFetch,
} from '../openai.js';
import { responsesFunctionTools, toolsForTenant, voiceTool, delegationInstructions } from '../catalogue.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: any = (AjvImport as any).default ?? AjvImport;
const tools = responsesFunctionTools(toolsForTenant('orgiq'));
const input = { model: 'gpt-live-1', instructions: 'front', delegationInstructions: delegationInstructions('orgiq'), voice: 'marin', delegationModel: 'gpt-6-luna', tools };

describe('the mint body', () => {
  const body = liveSessionBody(input) as Record<string, any>;

  it('puts the tools only under delegation.responses, strict, and never a session.tools array', () => {
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body)).not.toContain('web_search');
    expect(body['delegation']).toMatchObject({
      type: 'responses',
      responses: { model: 'gpt-6-luna', instructions: expect.stringContaining('"orgiq"'), tool_choice: 'auto', parallel_tool_calls: false },
    });
    for (const t of body['delegation'].responses.tools) expect(t).toMatchObject({ type: 'function', strict: true });
    expect(body['delegation'].responses.tools.map((t: { name: string }) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it('carries the minimal data-channel allowlist: the browser cannot send session.update or replace the instructions', () => {
    expect(body['client'].data_channel.allowed_client_events).toEqual([
      'session.close', 'session.input_audio.mute', 'session.input_audio.unmute',
      'response.item.create', 'response.create', 'session.thinking.append', 'session.commentary.append',
    ]);
    expect(body['client'].data_channel.allowed_client_events).not.toContain('session.update');
    expect(body['client'].data_channel.allowed_client_events).not.toContain('session.instructions.append');
    expect(body['client'].data_channel.allowed_server_events).toContainEqual({ type: 'response.event', response_event: 'response.output_item.done' });
    expect(ALLOWED_CLIENT_EVENTS).toHaveLength(7);
  });

  it('without a delegation model there is no delegation block, but the allowlist still applies', () => {
    const plain = liveSessionBody({ ...input, delegationModel: null }) as Record<string, any>;
    expect(plain).not.toHaveProperty('delegation');
    expect(plain).not.toHaveProperty('tools');
    expect(plain['client'].data_channel.allowed_client_events).not.toContain('session.update');
    expect(plain['audio']).toEqual({ output: { voice: 'marin' } });
    expect((liveSessionBody({ ...input, voice: 'voice_abc123' }) as Record<string, any>)['audio']).toEqual({ output: { voice: { id: 'voice_abc123' } } });
  });

  it('snapshot of the orgiq delegation tools as sent', () => {
    expect(body['delegation'].responses.tools).toMatchSnapshot();
  });
});

describe('strict schemas', () => {
  it('list every property as required at every level, optional ones nullable', () => {
    const s = liveFunctionTool(tools.find((t) => t.name === 'search')!)['parameters'] as Record<string, any>;
    expect(s['required']).toEqual(['query', 'type', 'scope', 'sort', 'limit', 'answer', 'detail']);
    expect(s['properties'].answer.type).toEqual(['boolean', 'null']);
    expect(s['properties'].limit.type).toEqual(['integer', 'null']);
    expect(s['properties'].sort.enum).toEqual(['relevance', 'recent', null]);
    expect(s['properties'].query.type).toBe('string');
    const nav = liveFunctionTool(tools.find((t) => t.name === 'open')!)['parameters'] as Record<string, any>;
    expect(nav['properties'].params.type).toEqual(['object', 'null']);
    expect(nav['properties'].params.required).toEqual(['q', 'type', 'id']);
    expect(nav['properties'].params.additionalProperties).toBe(false);
  });

  it('every strict schema compiles, and a strict call with nulls validates once its nulls are dropped', () => {
    const ajv = new Ajv({ strict: false });
    for (const t of tools) ajv.compile(strictSchema(t.parameters as unknown as Record<string, unknown>));
    const call = { query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null, detail: null };
    expect(ajv.compile(strictSchema(voiceTool('search')!.parameters as unknown as Record<string, unknown>))(call)).toBe(true);
    const dropped = Object.fromEntries(Object.entries(call).filter(([, v]) => v !== null));
    expect(new Ajv({ strict: true }).compile(voiceTool('search')!.parameters)(dropped)).toBe(true);
  });
});

describe('the mint call', () => {
  afterEach(() => { _setVoiceFetch(null); delete process.env['OPENAI_API_KEY']; });

  it('reads the 201 { session: { id: live_… }, transport: { sdp } } answer', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test';
    _setVoiceFetch(async () => ({ status: 201, ok: true, text: async () => JSON.stringify({ session: { id: 'live_u0_abc' }, transport: { type: 'webrtc', sdp: 'v=0\r\n' } }) }));
    await expect(createLiveSession('v=0\r\n', input)).resolves.toEqual({ providerSessionId: 'live_u0_abc', sdp: 'v=0\r\n' });
  });
});

describe('the MOCK_VOICE script', () => {
  const script = mockLiveScript('vs_00000000-0000-4000-8000-000000000001', {
    name: 'search', arguments: { query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null }, said: 'Find me the latest Kubernetes experts.',
  });

  it('delivers the tool call as the Live API does: delegation.created, then response.event envelopes ending in output_item.done', () => {
    const types = script.onStart.map((f) => f.event['type'] === 'response.event' ? `response.event/${(f.event['event'] as { type: string }).type}` : f.event['type']);
    expect(types).toEqual([
      'session.started', 'session.input_transcript.delta', 'session.delegation.created', 'response.event/response.created',
      'response.event/response.output_item.added', 'response.event/response.function_call_arguments.done',
      'response.event/response.output_item.done', 'response.event/response.completed', 'session.usage.updated',
    ]);
    const created = script.onStart[2]!.event as { delegation: { id: string; target: string } };
    const done = script.onStart[6]!.event as { delegation_id: string; event: { item: Record<string, unknown> } };
    expect(created.delegation.target).toBe('responses');
    expect(done.delegation_id).toBe(created.delegation.id);
    expect(done.event.item).toMatchObject({ type: 'function_call', status: 'completed', name: 'search', call_id: expect.stringMatching(/^call_/) });
    expect(JSON.parse(done.event.item['arguments'] as string)).toEqual({ query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null });
    // The arguments-done event carries no name or call_id, as recorded.
    expect(script.onStart[5]!.event['event']).not.toHaveProperty('name');
    // response.completed is not the call's result: its output is always [].
    expect((script.onStart[7]!.event['event'] as { response: { output: unknown[] } }).response.output).toEqual([]);
  });

  it('continues under the same delegation after response.create, and closes with cumulative usage of at least 15 s', () => {
    expect(script.onResponseCreate.some((f) => f.event['type'] === 'session.output_transcript.delta')).toBe(true);
    expect(script.onResponseCreate[0]!.event['delegation_id']).toBe(script.onStart[2]!.event['delegation'] && (script.onStart[2]!.event['delegation'] as { id: string }).id);
    expect(script.onClose[0]!.event).toMatchObject({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 15 } });
    const times = script.onStart.map((f) => f.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

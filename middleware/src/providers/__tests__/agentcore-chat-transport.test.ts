// The chat composer can explicitly address read specialists. Older deployed
// specialists return one A2A JSON envelope; newer ones stream AG-UI. Both must
// preserve one observable turn through the same existing transport.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { agentcore: false }, agentcore: {} } }));
const mockDataSend = jest.fn();
const mockControlSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  ...jest.requireActual('@aws-sdk/client-bedrock-agentcore'),
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockDataSend })),
}));
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  ...jest.requireActual('@aws-sdk/client-bedrock-agentcore-control'),
  BedrockAgentCoreControlClient: jest.fn(() => ({ send: mockControlSend })),
}));
import { realAgentCore } from '../agentcore.js';
async function* chunks(...strings: string[]) { for (const text of strings) yield new TextEncoder().encode(text); }
async function invoke(agent: string, response: AsyncIterable<Uint8Array>) {
  mockDataSend.mockResolvedValue({ response });
  const events: Array<Record<string, unknown>> = [];
  for await (const event of realAgentCore.invokeAgentStreaming(agent, { message: 'Who owns the initiative?', sessionId: 'session-123456789012345678901234567890', userId: 'u-member', auth: { sub: 'u-member', role: 'member' }, history: [{ role: 'user', content: 'Auth Migration' }] })) events.push(event as Record<string, unknown>);
  return events;
}
beforeEach(() => {
  mockDataSend.mockReset();
  mockControlSend.mockResolvedValue({ agentRuntimes: ['search', 'advisor', 'supervisor'].map(name => ({ agentRuntimeName: `orgiq_${name}`, agentRuntimeArn: `arn:test:${name}` })) });
});
test.each(['orgiq-search', 'orgiq-advisor'])('%s JSON answer and tool evidence become a visible chat turn', async agent => {
  const body = JSON.stringify({ agent, response: 'Vera owns the initiative.', toolCalls: [{ id: 'lookup', name: 'query_graph', args: { query: 'owner' }, result: { owner: 'Vera' } }] });
  const events = await invoke(agent, chunks(body.slice(0, 40), body.slice(40)));
  expect(events.map(e => e.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END']);
  expect(events.find(e => e.type === 'TEXT_MESSAGE_CONTENT')?.delta).toBe('Vera owns the initiative.');
  expect(events.find(e => e.type === 'TOOL_CALL_RESULT')?.content).toEqual({ owner: 'Vera' });
  const sent = JSON.parse(new TextDecoder().decode(mockDataSend.mock.calls[0][0].input.payload));
  expect(sent).toMatchObject({ stream: true, userId: 'u-member', auth: { sub: 'u-member', role: 'member' }, history: [{ role: 'user', content: 'Auth Migration' }] });
});
test('native AG-UI streaming is forwarded once without an extra synthesized answer', async () => {
  const events = await invoke('orgiq-supervisor', chunks('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"Hello"}\n\n'));
  expect(events).toEqual([{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hello' }]);
});
test('an A2A agent error stays an error instead of a blank successful turn', async () => {
  expect(await invoke('orgiq-search', chunks(JSON.stringify({ agent: 'search', error: 'Source unavailable' })))).toEqual([{ type: 'RUN_ERROR', message: 'Source unavailable' }]);
});
test('a malformed non-SSE response is surfaced as a stream error', async () => {
  const events = await invoke('orgiq-advisor', chunks('<html>Upstream failed</html>'));
  expect(events).toEqual([expect.objectContaining({ type: 'RUN_ERROR', message: expect.stringContaining('unparseable response') })]);
});

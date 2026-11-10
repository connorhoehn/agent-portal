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
it('sends evidence, mode and trusted tenant to the actual runtime command rather than dropping them', async () => {
  mockControlSend.mockResolvedValue({ agentRuntimes: [{ agentRuntimeName: 'orgiq_assessment_scorer', agentRuntimeArn: 'arn:test:runtime' }] });
  mockDataSend.mockResolvedValue({ response: { transformToString: async () => JSON.stringify({ response: '{"scores":[]}' }) } });
  const input = { team_id: 'TEAM-001', mode: 'survey', evidence: [{ id: 'sub1', text: 'Forms response' }], auth: { tenant: 'assessment', sub: 'u-asha' } };
  await realAgentCore.invokeAgent('orgiq-assessment-scorer', { message: 'Score', structuredInput: input, timeoutMs: 900000 });
  const [command, options] = mockDataSend.mock.calls[0];
  const sent = JSON.parse(new TextDecoder().decode(command.input.payload));
  const { auth, ...fields } = input;
  expect(JSON.parse(sent.input)).toEqual(fields);
  expect(sent.auth).toEqual(auth);
  expect(command.input.agentRuntimeArn).toBe('arn:test:runtime');
  expect(options.abortSignal).toBeDefined();
});

it('nests caller input under `input` and sets identity last: an input `tenant` or `auth` never reaches the top level', async () => {
  mockDataSend.mockReset();
  mockDataSend.mockResolvedValue({ response: { transformToString: async () => JSON.stringify({ response: 'ok' }) } });
  await realAgentCore.invokeAgent('orgiq-assessment-scorer', {
    message: 'find the plan',
    structuredInput: { tenant: 'assessment', authSig: 'v1.forged', sub: 'u-other', runId: 'r-other', mode: 'x' },
    auth: { sub: 'u-member', role: 'member', tenant: 'orgiq' } as never,
    sessionId: 's-1',
  });
  const sent = JSON.parse(new TextDecoder().decode(mockDataSend.mock.calls[0][0].input.payload));
  expect(sent.tenant).toBeUndefined();
  expect(sent.sub).toBeUndefined();
  expect(sent.authSig).toBeUndefined();
  expect(sent.runId).toBeUndefined();
  expect(JSON.parse(sent.input)).toEqual({ mode: 'x' });
  expect(sent.auth).toEqual({ sub: 'u-member', role: 'member', tenant: 'orgiq' });
});

// Sweep 11 (L3): an agent that cold-started after the invoke was signed answers a retryable refusal
// (agents/_shared/invoke_auth.py STALE_SIGNATURE_CODE); the middleware invokes once more, freshly built.
const stale = { response: { transformToString: async () => JSON.stringify({ code: 'INVOKE_SIGNED_BEFORE_START', retryable: true }) } };
const answer = (text: string) => ({ response: { transformToString: async () => JSON.stringify({ response: text }) } });

it('invokes once more when the agent answers that it started after the signature, and only once', async () => {
  mockDataSend.mockReset();
  mockDataSend.mockResolvedValueOnce(stale).mockResolvedValueOnce(answer('the plan'));
  const out = await realAgentCore.invokeAgent('orgiq-assessment-scorer', { message: 'find the plan', sessionId: 's-1' });
  expect(mockDataSend).toHaveBeenCalledTimes(2);
  expect(out.text).toBe('the plan');
  mockDataSend.mockReset();
  mockDataSend.mockResolvedValue(stale);
  await realAgentCore.invokeAgent('orgiq-assessment-scorer', { message: 'find the plan', sessionId: 's-1' });
  expect(mockDataSend).toHaveBeenCalledTimes(2);
});

it('a streaming invoke retries the same refusal before yielding anything', async () => {
  const body = (text: string) => ({ response: (async function* () { yield new TextEncoder().encode(text); })() });
  mockDataSend.mockReset();
  mockDataSend
    .mockResolvedValueOnce(body(JSON.stringify({ code: 'INVOKE_SIGNED_BEFORE_START', retryable: true })))
    .mockResolvedValueOnce(body(JSON.stringify({ agent: 'search', response: 'the plan' })));
  const events: unknown[] = [];
  for await (const ev of realAgentCore.invokeAgentStreaming('orgiq-assessment-scorer', { message: 'find the plan', sessionId: 's-1' })) events.push(ev);
  expect(mockDataSend).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(events)).toContain('the plan');
  expect(JSON.stringify(events)).not.toContain('INVOKE_SIGNED_BEFORE_START');
});

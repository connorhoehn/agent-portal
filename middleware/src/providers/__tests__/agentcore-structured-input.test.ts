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
  expect(sent).toMatchObject(input);
  expect(command.input.agentRuntimeArn).toBe('arn:test:runtime');
  expect(options.abortSignal).toBeDefined();
});

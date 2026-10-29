// Call sites write a bff_call ledger entry from the Bedrock response's usage.

const send = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send })),
  ConverseCommand: jest.fn((i) => i),
  InvokeModelCommand: jest.fn((i) => i),
}));
const recordBffCall = jest.fn().mockResolvedValue(undefined);
jest.mock('../../providers/spend-ledger.js', () => ({ recordBffCall: (...a: unknown[]) => recordBffCall(...a) }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false, agentcore: false } } }));

import { judgeResponse } from '../judge.js';
import { embedText } from '../embedding.js';
import { reviewDiff } from '../change-reviewer.js';

beforeEach(() => { send.mockReset(); recordBffCall.mockClear(); });

it('judge meters its Converse call', async () => {
  send.mockResolvedValue({
    output: { message: { content: [{ text: '{"score":0.8,"rationale":"ok"}' }] } },
    usage: { inputTokens: 120, outputTokens: 30 },
  });
  await judgeResponse('q', 'a');
  expect(recordBffCall).toHaveBeenCalledWith(expect.objectContaining({
    feature: 'judge', usage: { inputTokens: 120, outputTokens: 30 },
  }));
});

it('embedding meters Titan input tokens', async () => {
  const embedding = new Array(1024).fill(0.1);
  send.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding, inputTextTokenCount: 9 })) });
  await embedText('hello');
  expect(recordBffCall).toHaveBeenCalledWith(expect.objectContaining({
    feature: 'embedding', usage: { inputTokens: 9, outputTokens: 0 },
  }));
});

it('change reviewer meters its Converse call', async () => {
  send.mockResolvedValue({
    output: { message: { content: [{ text: '{"verdict":"approve","summary":"s","findings":[]}' }] } },
    usage: { inputTokens: 500, outputTokens: 50 },
  });
  await reviewDiff({ title: 't', diff: 'd', truncated: false });
  expect(recordBffCall).toHaveBeenCalledWith(expect.objectContaining({ feature: 'sdlc-change-review' }));
});

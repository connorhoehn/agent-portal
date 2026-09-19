const mockConfig = { region: 'us-east-1', mock: { cloudwatch: false, agentcore: false, aurora: false } };
jest.mock('../../config.js', () => ({ config: mockConfig }));
const send = jest.fn();
jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class { send(input: unknown) { return send(input); } },
  DescribeLogGroupsCommand: class {}, StartQueryCommand: class {}, GetQueryResultsCommand: class {},
}));
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: class { send(input: unknown) { return send(input); } },
  ListAgentRuntimesCommand: class {},
}));
jest.mock('../trace-sink.js', () => ({ processTrace: jest.fn() }));

import { isAgentTraceIngestionActive, pollOnce, startTracePoller } from '../cw-trace-ingest.js';

const priorOffline = process.env['DEV_OFFLINE'];
beforeEach(() => {
  jest.useFakeTimers();
  send.mockClear();
  delete process.env['DEV_OFFLINE'];
  Object.assign(mockConfig.mock, { cloudwatch: false, agentcore: false, aurora: false });
});
afterEach(() => {
  jest.useRealTimers();
  if (priorOffline === undefined) delete process.env['DEV_OFFLINE'];
  else process.env['DEV_OFFLINE'] = priorOffline;
});

it.each(['cloudwatch', 'agentcore', 'aurora', 'offline'] as const)('does not poll AWS when %s is mocked or offline', async mode => {
  if (mode === 'offline') process.env['DEV_OFFLINE'] = 'true';
  else mockConfig.mock[mode] = true;
  expect(isAgentTraceIngestionActive()).toBe(false);
  startTracePoller();
  expect(jest.getTimerCount()).toBe(0);
  expect(await pollOnce()).toEqual({ ingested: 0, errors: 0 });
  expect(send).not.toHaveBeenCalled();
});

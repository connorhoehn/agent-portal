// /api/observability/summary polls getSummary on every dashboard tick, and each
// uncached call bills a listRuntimes (GetMetricData) + two GetMetricStatistics +
// a GetTraceSummaries against CloudWatch/X-Ray. These tests pin the TTL cache:
// a second call within the window serves the stored value and hits no client;
// a blind/empty result (the shared ZERO_SUMMARY sentinel) is NOT cached, so a
// later credential recovery isn't masked by a stale zero.

const cwSend = jest.fn();
const xraySend = jest.fn();
const cwLogsSend = jest.fn();
const listRuntimes = jest.fn();

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', accountId: '111111111111' },
}));

jest.mock('../agentcore.js', () => ({
  realAgentCore: { listRuntimes: (...a: unknown[]) => listRuntimes(...a) },
}));

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send(cmd: unknown) { return cwSend(cmd); } },
  GetMetricStatisticsCommand: class { constructor(public input: unknown) {} },
  PutMetricDataCommand: class { constructor(public input: unknown) {} },
  Statistic: { Sum: 'Sum' },
}));

jest.mock('@aws-sdk/client-xray', () => ({
  XRayClient: class { send(cmd: unknown) { return xraySend(cmd); } },
  GetTraceSummariesCommand: class { constructor(public input: unknown) {} },
  BatchGetTracesCommand: class { constructor(public input: unknown) {} },
}));

jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class { send(cmd: unknown) { return cwLogsSend(cmd); } },
  FilterLogEventsCommand: class { constructor(public input: unknown) {} },
}));

import { realCloudWatch, __resetObservabilityCache } from '../cloudwatch.js';

beforeEach(() => {
  cwSend.mockReset();
  xraySend.mockReset();
  listRuntimes.mockReset();
  __resetObservabilityCache();
});

describe('getSummary TTL cache', () => {
  it('serves the second call from cache within the TTL — no client calls', async () => {
    // One deployed runtime with real traffic → a non-zero (real) summary.
    listRuntimes.mockResolvedValue([
      { invocationsLast24h: 5, errorsLast24h: 1, latencyP50Ms: 200 },
    ]);
    cwSend.mockResolvedValue({ Datapoints: [{ Sum: 100, SampleCount: 1 }] });
    xraySend.mockResolvedValue({ TraceSummaries: [{ Id: 't-1' }] });

    const first = await realCloudWatch.getSummary();
    const second = await realCloudWatch.getSummary();

    // Same value, and the AWS clients were exercised exactly once total.
    expect(second).toEqual(first);
    expect(first.totalInvocations24h).toBe(5);
    expect(listRuntimes).toHaveBeenCalledTimes(1);
    expect(cwSend).toHaveBeenCalledTimes(2); // input + output token sums
    expect(xraySend).toHaveBeenCalledTimes(1); // countTraces
  });

  it('does not cache a blind/empty result, so recovery is not masked', async () => {
    // No runtimes, no tokens, no traces → the ZERO_SUMMARY sentinel.
    listRuntimes.mockResolvedValue([]);
    cwSend.mockResolvedValue({ Datapoints: [] });
    xraySend.mockResolvedValue({ TraceSummaries: [] });

    const first = await realCloudWatch.getSummary();
    expect(first.totalInvocations24h).toBe(0);

    // A blind result must NOT be pinned — the next poll re-hits the API.
    await realCloudWatch.getSummary();
    expect(listRuntimes).toHaveBeenCalledTimes(2);
  });
});

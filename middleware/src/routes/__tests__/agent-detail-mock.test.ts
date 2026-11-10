// The agent detail page's "Recent invocations" on the mock (routes/agent-detail.ts).
//
// The offline branch answered an empty list unconditionally, so the table read
// "No invocations recorded" for every agent under dev:mock. It now reads the
// same corpus every other observability read does (mock/observability.ts
// traceRows), under the same caller scope as the live query.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', accountId: '', auth: { policyStoreId: '' },
    mock: { aurora: true, agentcore: false, guardrails: true, cloudwatch: true } },
}));
jest.mock('../../providers/index.js', () => ({ agentcore: {
  listRuntimesResult: jest.fn(async () => ({ items: [{ id: 'rt-search', name: 'orgiq_search' }] })),
  getRuntimeMetrics: jest.fn(async () => null),
} }));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send() { return Promise.reject(new Error('offline')); } },
  GetPromptCommand: class {}, ListPromptsCommand: class {},
}));
jest.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class { send() { return Promise.reject(new Error('offline')); } },
  FilterLogEventsCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { agentDetailRouter } from '../agent-detail.js';
import { errorHandler } from '../../lib/async-handler.js';
import { traceRows } from '../../mock/observability.js';

function app(session: Record<string, unknown>) {
  const a = express();
  a.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { grants: {}, iat: 0, ...session }; next(); });
  a.use('/a', agentDetailRouter);
  a.use(errorHandler);
  return a;
}

const searchRows = () => traceRows().filter((r) => r.agent_id === 'orgiq-search');

it('the cross-tenant admin sees the agent\'s recent calls, newest first, at most 25', async () => {
  const res = await request(app({ sub: 'u-admin', role: 'admin', tenant: 'orgiq' })).get('/a/orgiq_search').expect(200);
  expect(res.body.invocations.length).toBe(Math.min(25, searchRows().length));
  expect(res.body.invocations.length).toBeGreaterThan(0);
  expect(res.body.invocations[0]).toMatchObject({ invocationId: searchRows()[0]!.invocation_id, promptSnippet: expect.any(String) });
  expect(res.body.invocationsProblem).toBeUndefined();
});

it('a member sees only their own calls', async () => {
  const owner = searchRows().find((r) => r.user_id)!.user_id!;
  const res = await request(app({ sub: owner, role: 'member', tenant: 'orgiq' })).get('/a/orgiq_search').expect(200);
  const ids = new Set(searchRows().filter((r) => r.user_id === owner).map((r) => r.invocation_id));
  expect(res.body.invocations.length).toBeGreaterThan(0);
  for (const row of res.body.invocations as Array<{ invocationId: string }>) expect(ids.has(row.invocationId)).toBe(true);
});

import express from 'express';
import request from 'supertest';
import { createHealthHandler, livezHandler } from '../health-handler.js';
import { judgeSnapshot, resolveRuntimeProfile, securityPreconditions, validateRuntimeProfile } from '../runtime-profile.js';
import type { HealthProbeSnapshot } from '../health-probe.js';

const live = { aurora: false, agentcore: false, guardrails: false, cloudwatch: false };
const mocked = { aurora: true, agentcore: true, guardrails: true, cloudwatch: true };

function app(options: Partial<Parameters<typeof createHealthHandler>[0]> = {}) {
  const value = express();
  value.get('/health', createHealthHandler({ readRealtime: () => ({ ready: true }), readAws: () => ({ ok: true }),
    readDatastore: () => ({ ok: true }), mocks: live, region: 'test', ...options }));
  value.get('/livez', livezHandler);
  return value;
}

describe('static runtime profile', () => {
  it('defaults to local-ephemeral and accepts every mock and an in-process queue', () => {
    const config = resolveRuntimeProfile({ mock: mocked, inProcessQueue: true });
    expect(config.profile).toBe('local-ephemeral');
    expect(validateRuntimeProfile(config)).toEqual([]);
  });

  it('accepts a durable profile on real providers', () => {
    expect(validateRuntimeProfile(resolveRuntimeProfile({ profile: 'durable', mock: live, inProcessQueue: false }))).toEqual([]);
  });

  it.each([
    ['mock Aurora', { mock: { ...live, aurora: true } }, /agent-jobs needs "persistent" from aurora: MOCK_AURORA/],
    ['a mock agent runtime', { mock: { ...live, agentcore: true } }, /agent-jobs needs "agent-runtime" from aws/],
    ['an in-process queue', { inProcessQueue: true }, /pipeline-queues needs "durable-delivery" from message-queue: set MESSAGE_QUEUE_URL/],
    ['an unknown profile', { profile: 'prod' }, /ORGIQ_RUNTIME_PROFILE/],
  ])('refuses durable with %s', (_label, override, problem) => {
    const problems = validateRuntimeProfile(resolveRuntimeProfile({ profile: 'durable', mock: live, inProcessQueue: false, ...override }));
    expect(problems.join('\n')).toMatch(problem);
  });
});

describe('snapshot judgement', () => {
  it('keeps a refreshing verdict inside its age budget and rejects untested, failed or over-age ones', () => {
    expect(judgeSnapshot({ ok: true, checkedAt: 1_000, stale: true, refreshing: true }, 60_000, 50_000)).toEqual({ ok: true });
    expect(judgeSnapshot({ ok: true, checkedAt: 1_000, stale: true }, 60_000, 62_000).ok).toBe(false);
    expect(judgeSnapshot({ ok: false, error: 'CheckPending', refreshing: true }, 60_000)).toEqual({ ok: false, error: 'CheckPending' });
    expect(judgeSnapshot({ ok: false, error: 'Aurora cluster not found' }, 60_000).error).toBe('Aurora cluster not found');
  });
});

describe('durable readiness', () => {
  const ready: HealthProbeSnapshot = { ok: true, checkedAt: Date.now() };
  const durable = { profile: 'durable' as const, readJobSchema: () => ready, readQueue: () => ready };

  it('is 200 ok when every mandatory dependency is proven', async () => {
    const response = await request(app(durable)).get('/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', profile: 'durable' });
    expect(Object.values(response.body.capabilities).every((c: unknown) => (c as { mandatory: boolean }).mandatory)).toBe(true);
  });

  it.each([
    ['a failed datastore', { readDatastore: () => ({ ok: false, error: 'Aurora is resuming from idle' }) }, 'datastore'],
    ['an untested credential check', { readAws: () => ({ ok: false, error: 'CheckPending', refreshing: true }) }, 'awsCredentials'],
    ['an over-age datastore verdict', { readDatastore: () => ({ ok: true, checkedAt: Date.now() - 120_000, stale: true }) }, 'datastore'],
    ['a missing job-attempt schema', { readJobSchema: () => ({ ok: false, error: 'agent_jobs lacks claim_token/heartbeat_at' }) }, 'jobSchema'],
    ['a lost queue', { readQueue: () => ({ ok: false, error: 'message-queue not ready' }) }, 'messageQueue'],
    ['no queue probe at all', { readQueue: undefined }, 'messageQueue'],
  ])('is 503 with %s and names the dependency', async (_label, override, name) => {
    const response = await request(app({ ...durable, ...override })).get('/health').expect(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.capabilities[name]).toMatchObject({ ok: false, mandatory: true });
  });

  it('keeps the lease-loss 503 ahead of every dependency probe', async () => {
    const readAws = jest.fn(), readDatastore = jest.fn(), readJobSchema = jest.fn();
    await request(app({ ...durable, readRealtime: () => ({ ready: false }), readAws, readDatastore, readJobSchema })).get('/health').expect(503);
    expect(readAws).not.toHaveBeenCalled(); expect(readJobSchema).not.toHaveBeenCalled();
  });
});

describe('local-ephemeral readiness', () => {
  it('reports the same failures as degraded with HTTP 200', async () => {
    const response = await request(app({ readDatastore: () => ({ ok: false, error: 'offline' }),
      readJobSchema: () => ({ ok: false, error: 'missing columns' }) })).get('/health').expect(200);
    expect(response.body.status).toBe('degraded');
    expect(response.body.capabilities.jobSchema).toEqual({ ok: false, mandatory: false, error: 'missing columns' });
  });

  it('serves liveness without consulting any dependency', async () => {
    const readDatastore = jest.fn();
    const response = await request(app({ readRealtime: () => ({ ready: false }), readDatastore })).get('/livez').expect(200);
    expect(response.body.status).toBe('alive');
    expect(readDatastore).not.toHaveBeenCalled();
  });
});

describe('fail-closed start-up preconditions (docs/fail-open-audit.md §2)', () => {
  const deployed = { NODE_ENV: 'production', SESSION_SIGNING_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:s', POLICY_STORE_ID: 'ps-1' };

  it('a configured deployment has none, in either profile', () => {
    expect(securityPreconditions(deployed)).toEqual([]);
    expect(validateRuntimeProfile(resolveRuntimeProfile({ profile: 'durable', mock: live, inProcessQueue: false, env: deployed }))).toEqual([]);
  });

  it('names each missing value, and INSECURE_DEV_MODE never waives them in production', () => {
    const problems = securityPreconditions({ NODE_ENV: 'production', INSECURE_DEV_MODE: 'true' }).join('\n');
    expect(problems).toMatch(/SESSION_SIGNING_SECRET_ARN unset and INSECURE_DEV_MODE is not set/);
    expect(problems).toMatch(/POLICY_STORE_ID unset and INSECURE_DEV_MODE is not set/);
  });

  it('INSECURE_DEV_MODE waives them outside production; an explicit SESSION_SIGNING_KEY_DEV counts as a key; blank is unset', () => {
    expect(securityPreconditions({ INSECURE_DEV_MODE: 'true' })).toEqual([]);
    expect(securityPreconditions({ SESSION_SIGNING_KEY_DEV: 'operator-key', POLICY_STORE_ID: 'ps-1' })).toEqual([]);
    expect(securityPreconditions({ SESSION_SIGNING_SECRET_ARN: ' ', POLICY_STORE_ID: 'ps-1' })).toHaveLength(1);
  });

  it('a REPLACE_ME placeholder counts as unset', () => {
    expect(securityPreconditions({ SESSION_SIGNING_SECRET_ARN: 'REPLACE_ME', POLICY_STORE_ID: 'REPLACE_ME' })).toHaveLength(2);
    expect(securityPreconditions({ SESSION_SIGNING_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:x', POLICY_STORE_ID: 'ps-1' })).toEqual([]);
  });

  it('/health reports insecureDevMode only when it is on', async () => {
    expect((await request(app({ insecureDevMode: true })).get('/health')).body.insecureDevMode).toBe(true);
    expect((await request(app()).get('/health')).body).not.toHaveProperty('insecureDevMode');
  });
});

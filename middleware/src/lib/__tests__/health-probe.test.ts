import express from 'express';
import request from 'supertest';
import { createHealthProbe, type HealthProbeStatus } from '../health-probe.js';
import { createHealthHandler } from '../health-handler.js';

function deferred() {
  let resolve!: (status: HealthProbeStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<HealthProbeStatus>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => jest.restoreAllMocks());

it('cold health polls respond while one diagnostic call remains outstanding', async () => {
  const blocked = deferred(), run = jest.fn(() => blocked.promise);
  const probe = createHealthProbe(100, run, () => 'Offline');
  const app = express();
  app.get('/health', createHealthHandler({ readRealtime: () => ({ ready: true }), readAws: probe.snapshot,
    readDatastore: () => ({ ok: true }), mocks: { aurora: false }, region: 'test' }));
  for (let i = 0; i < 3; i++) {
    const response = await request(app).get('/health').expect(200);
    expect(response.body.status).toBe('degraded');
    expect(response.body.awsCredentials).toEqual({ ok: false, error: 'CheckPending', refreshing: true });
  }
  expect(run).toHaveBeenCalledTimes(1);
  blocked.resolve({ ok: true }); await probe.check();
  expect((await request(app).get('/health')).body.status).toBe('ok');
});

it('an expired successful diagnostic is marked stale until its single refresh completes', async () => {
  let now = 1_000; jest.spyOn(Date, 'now').mockImplementation(() => now);
  const refresh = deferred(), run = jest.fn().mockResolvedValueOnce({ ok: true }).mockImplementation(() => refresh.promise);
  const probe = createHealthProbe(100, run, () => 'Offline');
  await probe.check(); now = 1_101;
  expect(probe.snapshot()).toEqual({ ok: true, checkedAt: 1_000, refreshing: true, stale: true });
  probe.snapshot(); await Promise.resolve(); expect(run).toHaveBeenCalledTimes(2);
  refresh.reject(new Error('offline')); await probe.check();
  expect(probe.snapshot()).toEqual({ ok: false, error: 'Offline', checkedAt: 1_101, refreshing: false, stale: false });
});

it('a probe reset cannot let an older completion overwrite the newer verdict', async () => {
  const older = deferred(), newer = deferred();
  const probe = createHealthProbe(100, jest.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise), () => 'Offline');
  const oldRead = probe.check(); probe.reset(); const newRead = probe.check();
  newer.resolve({ ok: false, error: 'Offline' }); await newRead;
  older.resolve({ ok: true }); await oldRead;
  expect(probe.snapshot().ok).toBe(false);
});

it('caller mutations cannot turn a failed cached diagnostic into a success', async () => {
  const probe = createHealthProbe(100, async () => ({ ok: false, error: 'Offline' }), () => 'Offline');
  const answer = await probe.check(); answer.ok = true;
  const snapshot = probe.snapshot(); snapshot.ok = true;
  expect(probe.snapshot().ok).toBe(false);
});

it('a fenced router responds 503 without dispatching dependency probes', async () => {
  const readAws = jest.fn(), readDatastore = jest.fn(), app = express();
  const handler = createHealthHandler({ readRealtime: () => ({ ready: false }), readAws, readDatastore, mocks: {}, region: 'test' });
  app.get('/health', handler); app.get('/api/health', handler);
  for (const path of ['/health', '/api/health']) {
    const response = await request(app).get(path).expect(503);
    expect(response.body.realtime.ready).toBe(false);
  }
  expect(readAws).not.toHaveBeenCalled(); expect(readDatastore).not.toHaveBeenCalled();
});

it('the health response never calls an expired dependency verdict healthy', async () => {
  const app = express();
  app.get('/health', createHealthHandler({ readRealtime: () => ({}), readAws: () => ({ ok: true }),
    readDatastore: () => ({ ok: true, stale: true, refreshing: true }), mocks: {}, region: 'test' }));
  expect((await request(app).get('/health').expect(200)).body.status).toBe('degraded');
});

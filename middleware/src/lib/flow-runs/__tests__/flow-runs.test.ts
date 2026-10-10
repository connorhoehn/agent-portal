jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true } } }));
jest.mock('../../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../../providers/aurora.js', () => ({ exec: jest.fn() }));

import { flowRunsFixture } from '../../../mock/flow-runs.js';
import { config } from '../../../config.js';
import { exec } from '../../../providers/aurora.js';
import { freezeClock, unfreezeClock } from '../../../mock/core/clock.js';
import { flowRunStore, registerFlowExecutor, dispatchFlowRuns, kickFlowRun, pendingFlowRuns } from '../index.js';
import { SUMMARIZE_KIND, SUMMARIZE_TENANT, getRunFor, summarizeView } from '../../social-summarize.js';

const settle = async (): Promise<void> => { while (pendingFlowRuns.size) await Promise.all([...pendingFlowRuns]); };
const mk = (over: Partial<Parameters<typeof flowRunStore.create>[0]> = {}) =>
  flowRunStore.create({ tenant: 'test', kind: 'test.kind', requestedBy: 'u-a', scope: 'room', input: { secret: 'x' }, ...over });

afterEach(() => { flowRunsFixture.reset(); unfreezeClock(); });

describe('single executor', () => {
  it('two nodes racing for one queued run: exactly one claims it, once', async () => {
    const run = await mk();
    const claims = await Promise.all([
      flowRunStore.claim({ kinds: ['test.kind'], owner: 'node-a', leaseMs: 60_000 }),
      flowRunStore.claim({ kinds: ['test.kind'], owner: 'node-b', leaseMs: 60_000 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await flowRunStore.get(run.id))).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('two dispatchers executing the same queued run invoke the executor once', async () => {
    const exec1 = jest.fn(async () => ({ result: { ok: true } }));
    registerFlowExecutor('test.kind', exec1);
    const run = await mk();
    await Promise.all([dispatchFlowRuns('node-a'), dispatchFlowRuns('node-b')]);
    await settle();
    expect(exec1).toHaveBeenCalledTimes(1);
    expect(await flowRunStore.get(run.id)).toMatchObject({ status: 'completed', result: { ok: true }, input: null, leaseOwner: null });
  });

  it('a node that lost its lease cannot write progress or a result over its replacement', async () => {
    const run = await mk({ maxAttempts: 2 });
    await flowRunStore.claim({ kinds: ['test.kind'], owner: 'node-a', leaseMs: 1_000 });
    freezeClock(new Date(Date.now() + 5_000));
    await flowRunStore.expireLeases();
    await flowRunStore.claim({ kinds: ['test.kind'], owner: 'node-b', leaseMs: 60_000 });
    expect(await flowRunStore.progress(run.id, 'node-a', [], 60_000)).toBe(false);
    expect(await flowRunStore.finish(run.id, 'node-a', { status: 'completed', result: 'stale' })).toBe(false);
    expect(await flowRunStore.finish(run.id, 'node-b', { status: 'completed', result: 'fresh' })).toBe(true);
    expect((await flowRunStore.get(run.id))?.result).toBe('fresh');
  });
});

describe('expired-lease recovery', () => {
  it('re-queues a run whose worker died, and the next tick executes it', async () => {
    const exec1 = jest.fn(async () => ({ result: 'done' }));
    registerFlowExecutor('test.kind', exec1);
    const run = await mk({ maxAttempts: 2 });
    await flowRunStore.claim({ kinds: ['test.kind'], owner: 'dead-node', leaseMs: 60_000 });
    await dispatchFlowRuns('node-b'); await settle();
    expect(exec1).not.toHaveBeenCalled();                      // lease still held
    freezeClock(new Date(Date.now() + 61_000));
    await dispatchFlowRuns('node-b'); await settle();
    expect(exec1).toHaveBeenCalledTimes(1);
    expect(await flowRunStore.get(run.id)).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('fails visibly once attempts are exhausted, and drops the private input', async () => {
    const run = await mk({ maxAttempts: 1, progress: [{ id: 's', label: 'S', status: 'running' }] });
    await flowRunStore.claim({ kinds: ['test.kind'], owner: 'dead-node', leaseMs: 1_000 });
    freezeClock(new Date(Date.now() + 5_000));
    const { failed } = await flowRunStore.expireLeases();
    expect(failed).toHaveLength(1);
    expect(await flowRunStore.get(run.id)).toMatchObject({
      status: 'failed', input: null, error: expect.stringContaining('lease'), progress: [{ id: 's', status: 'failed' }] });
  });

  it('an executor that throws fails the run with its message (no retry)', async () => {
    registerFlowExecutor('test.kind', async () => { throw new Error('boom'); });
    const run = await mk({ maxAttempts: 3 });
    kickFlowRun(run.id, 'test.kind'); await settle();
    expect(await flowRunStore.get(run.id)).toMatchObject({ status: 'failed', error: 'boom', attempts: 1 });
  });
});

describe('Social /summarize durability', () => {
  const line = { messageId: 'm1', author: 'Mira', text: 'Release is Thursday.', at: '2026-10-01T10:00:00.000Z' };

  it('a queued run survives a restart (nothing in memory) and completes on the next dispatcher pass', async () => {
    const run = await flowRunStore.create({ tenant: SUMMARIZE_TENANT, kind: SUMMARIZE_KIND, requestedBy: 'u-sana', scope: 'social:ch:general',
      idPrefix: 'sum', maxAttempts: 2, input: { lines: [line], instruction: '' },
      progress: [{ id: 'read-history', label: 'Read', status: 'completed' }, { id: 'summarize', label: 'W', status: 'pending' }, { id: 'check', label: 'C', status: 'pending' }] });
    expect(pendingFlowRuns.size).toBe(0);                      // the "old process" is gone
    expect(summarizeView((await getRunFor('u-sana', run.id))!).phase).toBe('received');
    await dispatchFlowRuns('node-after-restart'); await settle();
    const done = summarizeView((await getRunFor('u-sana', run.id))!);
    expect(done.phase).toBe('completed');
    expect(done.result?.sourceSpans[0]?.text).toBe('Release is Thursday.');
  });

  it('only the requester reads a run', async () => {
    const run = await mk({ tenant: SUMMARIZE_TENANT, kind: SUMMARIZE_KIND });
    expect(await getRunFor('u-a', run.id)).not.toBeNull();
    expect(await getRunFor('u-b', run.id)).toBeNull();
    expect(await flowRunStore.getFor('other-tenant', 'u-a', run.id)).toBeNull();
  });

  it('posting is claimed once, atomically', async () => {
    const run = await mk();
    const wins = await Promise.all([flowRunStore.setMetaOnce(run.id, 'u-a', 'postedAt', 'now'), flowRunStore.setMetaOnce(run.id, 'u-a', 'postedAt', 'now')]);
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await flowRunStore.setMetaOnce(run.id, 'u-b', 'other', 'x')).toBe(false);
  });
});

describe('Aurora statements', () => {
  const sql = exec as jest.Mock;
  beforeEach(() => { (config.mock as { aurora: boolean }).aurora = false; sql.mockReset(); sql.mockResolvedValue([]); });
  afterEach(() => { (config.mock as { aurora: boolean }).aurora = true; });

  it('claims with one UPDATE that skips locked rows', async () => {
    await flowRunStore.claim({ kinds: ['a', 'b'], owner: 'n', leaseMs: 1000, id: 'x' });
    const [text, params] = sql.mock.calls[0]!;
    expect(text).toMatch(/UPDATE flow_runs[\s\S]*FOR UPDATE SKIP LOCKED[\s\S]*RETURNING/);
    expect(params).toEqual(expect.arrayContaining([{ name: 'kinds', value: { stringValue: 'a,b' } }]));
  });

  it('fences progress and finish on the lease owner; reads filter on the requester', async () => {
    await flowRunStore.progress('r', 'n', null, 1000);
    await flowRunStore.finish('r', 'n', { status: 'completed', result: {} });
    expect(sql.mock.calls[0]![0]).toMatch(/lease_owner = :owner/);
    expect(sql.mock.calls[1]![0]).toMatch(/status = 'running' AND lease_owner = :owner/);
    expect(sql.mock.calls[1]![0]).toMatch(/input = NULL/);
    sql.mockResolvedValueOnce([{ id: 'r', tenant: 't', kind: 'k', requested_by: 'someone', scope: '', status: 'queued', attempts: 0, max_attempts: 1, created_at: 'c', updated_at: 'u' }]);
    expect(await flowRunStore.getFor('t', 'me', 'r')).toBeNull();
  });

  it('recovers lapsed leases in two statements: re-queue then fail', async () => {
    await flowRunStore.expireLeases();
    expect(sql.mock.calls[0]![0]).toMatch(/SET status = 'queued'[\s\S]*attempts < max_attempts/);
    expect(sql.mock.calls[1]![0]).toMatch(/SET status = 'failed'[\s\S]*attempts >= max_attempts/);
  });
});

// Actual provider SQL on a disposable PostgreSQL container. Each Data API call
// uses an independent psql connection; no shared DB, host port or AWS access.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
jest.mock('../../lib/search-index/writes.js', () => ({ noteSearchWrite: jest.fn(async () => {}) }));
import { exec } from '../aurora.js';
import { cancelJob, claimJob, claimNextJob, claimNextJobForWorker, completeJob, enqueueJob, getJob, heartbeatJob, listJobs, markRunning, requeueJob, reapStaleJobs, _resetPullSideProbe } from '../agent-jobs.js';

const live = process.env['REAL_JOB_ATTEMPTS_POSTGRES'] === '1' ? describe : describe.skip;
const command = promisify(execFile);
const container = `orgiq-job-attempts-${randomUUID()}`;
let created = false;
async function docker(...args: string[]) {
  return (await command('docker', args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
async function sql(statement: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', container, 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'orgiq_validation'],
      { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
    child.stdin!.end(statement);
  });
}
async function run(statement: string, params: SqlParameter[] = []) {
  const values = new Map(params.map(param => [param.name, param.value]));
  const bound = statement.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing SQL parameter: ${name}`);
    if (value.isNull) return 'NULL';
    if (value.longValue !== undefined) return String(value.longValue);
    if (value.doubleValue !== undefined) return String(value.doubleValue);
    if (value.booleanValue !== undefined) return value.booleanValue ? 'true' : 'false';
    return `'${String(value.stringValue ?? '').replace(/'/g, "''")}'`;
  });
  return JSON.parse(await sql(`WITH acceptance_rows AS (${bound}) SELECT COALESCE(json_agg(row_to_json(acceptance_rows)), '[]') FROM acceptance_rows;`));
}

live('agent job attempts on PostgreSQL', () => {
  beforeAll(async () => {
    await docker('run', '-d', '--name', container, '--label', 'orgiq.validation=job-attempts',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=orgiq_validation', 'postgres:16-alpine');
    created = true;
    const deadline = Date.now() + 15000;
    while (true) {
      try { await docker('exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'); break; }
      catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    const schema = readFileSync('../schema/agentic_work_schema.sql', 'utf8');
    const start = schema.indexOf('CREATE TABLE IF NOT EXISTS agent_jobs');
    await sql(schema.slice(start, schema.indexOf('\n);', start) + 3));
    // Referenced tables are empty; this suite exercises the production job SQL.
    await sql('CREATE TABLE agent_projects(id UUID PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY);');
    const botsSchema = readFileSync('../schema/agent_bots_schema.sql', 'utf8');
    const botsStart = botsSchema.indexOf('CREATE TABLE IF NOT EXISTS bots');
    await sql(botsSchema.slice(botsStart, botsSchema.indexOf('\n);', botsStart) + 3));
    await sql('ALTER TABLE agent_jobs ADD COLUMN bot_id UUID REFERENCES bots(id);');
    const workerSchema = readFileSync('../schema/local_compute_worker_schema.sql', 'utf8');
    for (const column of ['claim_token', 'heartbeat_at']) {
      const statement = workerSchema.match(new RegExp(`ALTER TABLE agent_jobs\\s+ADD COLUMN IF NOT EXISTS ${column} [^;]+;`));
      if (!statement) throw new Error(`Missing migration for ${column}`);
      await sql(statement[0]);
    }
    (exec as unknown as jest.Mock).mockImplementation(run);
  }, 30000);
  afterAll(async () => {
    if (!created) return;
    const label = await docker('inspect', '--format', '{{index .Config.Labels "orgiq.validation"}}', container);
    if (label.trim() !== 'job-attempts') throw new Error('Refusing to remove an unowned fixture');
    await docker('rm', '-f', container);
  });
  beforeEach(async () => { _resetPullSideProbe(); await sql('TRUNCATE agent_jobs;'); });

  it('lets two independent dispatchers claim only one live attempt', async () => {
    await enqueueJob({ kind: 'devbox:task', title: 'race', payload: {} });
    const claims = await Promise.all([claimNextJob('a', 'a'), claimNextJob('b', 'b')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('refuses missing and stale tokens after recovery and preserves the new result', async () => {
    const job = await enqueueJob({ kind: 'devbox:task', title: 'stale result', payload: {}, maxAttempts: 3 });
    const first = await claimNextJob('old', 'old');
    expect(await markRunning(first!.id, first!.claimToken)).toBe(true);
    await sql("UPDATE agent_jobs SET updated_at=NOW()-INTERVAL '1 hour', heartbeat_at=NOW()-INTERVAL '1 hour';");
    expect(await reapStaleJobs(1)).toEqual({ requeued: 1, failed: 0, failedIds: [] });
    const second = await claimNextJob('new', 'new');
    expect(second?.id).toBe(job?.id);
    expect(await completeJob(first!.id, { status: 'done', result: { owner: 'old' } })).toBe(false);
    const [persisted] = await run('SELECT status, box_id, result FROM agent_jobs');
    expect(persisted).toMatchObject({ status: 'claimed', box_id: 'new', result: null });
    expect(second!.claimToken).not.toBe(first!.claimToken);
    expect(await markRunning(first!.id, first!.claimToken)).toBe(false);
    expect(await heartbeatJob(first!.id, first!.claimToken)).toBe(false);
    expect(await completeJob(first!.id, { claimToken: first!.claimToken, status: 'failed', error: 'late' })).toBe(false);
    expect(await markRunning(second!.id, second!.claimToken)).toBe(true);
    expect(await completeJob(second!.id, { claimToken: second!.claimToken, status: 'done', result: { owner: 'new' } })).toBe(true);
    expect(await completeJob(second!.id, { claimToken: second!.claimToken, status: 'failed' })).toBe(false);
    expect((await getJob(second!.id))?.result).toEqual({ owner: 'new' });
  });

  it('revokes a cancelled claim and gives a manual retry a fresh identity', async () => {
    const job = await enqueueJob({ kind: 'devbox:task', title: 'cancel', payload: {} });
    const claim = (await claimJob(job!.id, 'cancel-box', 'cancel-session'))!;
    expect(await cancelJob(claim.id)).toBe(true);
    expect(await markRunning(claim.id, claim.claimToken)).toBe(false);
    expect(await heartbeatJob(claim.id, claim.claimToken)).toBe(false);
    expect(await completeJob(claim.id, { claimToken: claim.claimToken, status: 'done' })).toBe(false);
    const retried = await requeueJob(claim.id);
    expect(retried?.id).not.toBe(claim.id);
    expect(retried?.status).toBe('queued');
    expect((await getJob(claim.id))?.status).toBe('cancelled');
  });

  it('keeps a heartbeat alive, then revokes an expired attempt', async () => {
    const job = await enqueueJob({ kind: 'devbox:task', title: 'heartbeat', payload: {}, maxAttempts: 1 });
    const claim = (await claimJob(job!.id, 'box', 'session'))!;
    await sql("UPDATE agent_jobs SET updated_at=NOW()-INTERVAL '1 hour', heartbeat_at=NOW()-INTERVAL '1 hour';");
    expect(await heartbeatJob(claim.id, claim.claimToken)).toBe(true);
    expect(await reapStaleJobs(1)).toEqual({ requeued: 0, failed: 0, failedIds: [] });
    await sql("UPDATE agent_jobs SET updated_at=NOW()-INTERVAL '1 hour', heartbeat_at=NOW()-INTERVAL '1 hour';");
    expect(await reapStaleJobs(1)).toEqual({ requeued: 0, failed: 1, failedIds: [claim.id] });
    expect(await heartbeatJob(claim.id, claim.claimToken)).toBe(false);
    expect(await completeJob(claim.id, { claimToken: claim.claimToken, status: 'done' })).toBe(false);
    expect((await getJob(claim.id))?.status).toBe('failed');
  });

  it('uses the same fencing contract for pull workers and keeps tokens out of reads', async () => {
    await enqueueJob({ kind: 'devbox:task', title: 'pull', payload: { nodeId: 'a' } });
    const claim = (await claimNextJobForWorker({ boxId: 'local:a', sessionId: 'a', kinds: ['devbox:task'], nodeId: 'a' }))!;
    expect(claim.claimToken).toEqual(expect.any(String));
    expect(claim.job).not.toHaveProperty('claimToken');
    expect(await getJob(claim.job.id)).not.toHaveProperty('claimToken');
    expect(JSON.stringify(await listJobs())).not.toContain(claim.claimToken);
    expect(await markRunning(claim.job.id)).toBe(false);
    expect(await markRunning(claim.job.id, claim.claimToken)).toBe(true);
    // Failure results may omit JSON: an empty string must never be cast to jsonb.
    expect(await completeJob(claim.job.id, { claimToken: claim.claimToken, status: 'failed', error: 'worker failed' })).toBe(true);
    expect((await getJob(claim.job.id))?.error).toBe('worker failed');
  });

  it('does not revoke push or pull ownership during the zero-window boot sweep', async () => {
    await enqueueJob({ kind: 'devbox:task', title: 'push', payload: {} });
    const claim = (await claimNextJob('box', 'session'))!;
    expect(await reapStaleJobs(0, { includeFenced: false })).toEqual({ requeued: 0, failed: 0, failedIds: [] });
    expect(await heartbeatJob(claim.id, claim.claimToken)).toBe(true);
  });

  it('starts no SQL recovery mutation after the fleet lease is lost', async () => {
    await enqueueJob({ kind: 'devbox:task', title: 'recovery', payload: {} });
    const claim = (await claimNextJob('box', 'session'))!;
    await expect(reapStaleJobs(0, { assertLive() { throw new Error('lost recovery lock'); } })).rejects.toThrow('lost recovery lock');
    expect((await getJob(claim.id))?.status).toBe('claimed');
  });

  it('fails closed for every claim path before the fencing migration', async () => {
    await enqueueJob({ kind: 'devbox:task', title: 'unmigrated', payload: { nodeId: 'a' } });
    await sql('ALTER TABLE agent_jobs DROP COLUMN claim_token;');
    try {
      for (const claim of [() => claimNextJob('a', 'a'), () => claimJob('unused', 'a', 'a'),
        () => claimNextJobForWorker({ boxId: 'local:a', sessionId: 'a', kinds: ['devbox:task'], nodeId: 'a' })]) {
        await expect(claim()).rejects.toThrow('local_compute_worker_schema.sql');
      }
      const [row] = await run('SELECT status, attempts FROM agent_jobs');
      expect(row).toEqual({ status: 'queued', attempts: 0 });
    } finally { await sql('ALTER TABLE agent_jobs ADD COLUMN claim_token TEXT;'); }
  });


  it('refuses exhausted queued rows on every claim path', async () => {
    const job = (await enqueueJob({ kind: 'devbox:task', title: 'budget', payload: { nodeId: 'a' }, maxAttempts: 1 }))!;
    await sql('UPDATE agent_jobs SET attempts = max_attempts;');
    expect(await claimNextJob('a', 'a')).toBeNull();
    expect(await claimJob(job.id, 'a', 'a')).toBeNull();
    expect(await claimNextJobForWorker({ boxId: 'local:a', sessionId: 'a', kinds: ['devbox:task'], nodeId: 'a' })).toBeNull();
  });

});

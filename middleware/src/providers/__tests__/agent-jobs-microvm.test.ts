// The queue's half of the microVM runner (docs/microvm-runner-design.md §4,
// §9, §13, §14 step 3–4): the runner is set at enqueue from the initiative's
// profile, the fleet claim never takes a microvm row, the microVM claim takes
// nothing else, and the payload fields the runner refuses are a 400.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
const cfg = { region: 'us-east-1', mock: { aurora: true } };
jest.mock('../../config.js', () => ({ config: cfg }));

import { exec } from '../aurora.js';
import { _resetColumnProbes } from '../column-probe.js';
import {
  enqueueJob, claimNextJob, claimJob, claimNextMicrovmJob, stampJobPlacement, getMicrovmJobFacts, _resetMockQueue,
} from '../agent-jobs.js';
import { initiatives } from '../../mock/initiatives.js';
import { ValidationError } from '../../lib/async-handler.js';
import { decideReaping } from '../../lib/devbox-reaper.js';
import type { FleetBox } from '../../lib/devbox-fleet.js';

const RESTRICTED = 'p-auth-migration';
const execMock = exec as unknown as jest.Mock;

beforeEach(() => {
  cfg.mock.aurora = true;
  _resetMockQueue();
  initiatives.reset();
  initiatives.rows().find((p) => p.id === RESTRICTED)!.devboxProfileId = 'restricted';
  execMock.mockReset();
  _resetColumnProbes();
});

describe('enqueue sets the runner from the profile', () => {
  it('an egress-allowlist initiative queues microvm work with the actor; the fleet claim never takes it', async () => {
    const job = await enqueueJob({ kind: 'devbox:task', title: 't', payload: { prompt: 'p', initiativeId: RESTRICTED }, actorSub: 'u-nora', createdBy: 'u-nora' });
    expect(job).toMatchObject({ runner: 'microvm', actorSub: 'u-nora' });
    expect(await claimNextJob('box-a', 'session-a')).toBeNull();
    expect(await claimJob(job!.id, 'box-a', 'session-a')).toBeNull();
    const claimed = await claimNextMicrovmJob();
    expect(claimed).toMatchObject({ id: job!.id, status: 'claimed', attempts: 1, boxId: null, sessionId: null });
    expect(await stampJobPlacement(job!.id, claimed!.claimToken, 'mvm:s', 'mvm1-s')).toBe(true);
    expect(await stampJobPlacement(job!.id, 'clm_wrong', 'mvm:s', 'mvm1-s')).toBe(false);
    expect(await getMicrovmJobFacts(job!.id)).toMatchObject({ runner: 'microvm', actorSub: 'u-nora', boxId: 'mvm:s', sessionId: 'mvm1-s' });
  });

  it('a public initiative keeps the fleet, and the microVM claim never takes fleet work', async () => {
    const job = await enqueueJob({ kind: 'devbox:task', title: 't', payload: { prompt: 'p', initiativeId: 'p-observability' }, actorSub: 'u-nora' });
    expect(job!.runner).toBeUndefined();
    expect(await claimNextMicrovmJob({ excludeIds: [] })).toBeNull();
    expect(await claimNextJob('box-a', 'session-a')).not.toBeNull();
  });

  it('refuses resume and boxId in a microvm payload (400), and resumeOfJobId on fleet work', async () => {
    for (const extra of [{ resume: true }, { boxId: 'box-1' }]) {
      await expect(enqueueJob({ kind: 'devbox:task', title: 't', payload: { prompt: 'p', initiativeId: RESTRICTED, ...extra } }))
        .rejects.toBeInstanceOf(ValidationError);
    }
    await expect(enqueueJob({ kind: 'devbox:task', title: 't', payload: { prompt: 'p', initiativeId: 'p-observability' }, resumeOfJobId: 'job-x' }))
      .rejects.toThrow(/only accepted for microVM work/);
    const ok = await enqueueJob({ kind: 'devbox:task', title: 't', payload: { prompt: 'p', initiativeId: RESTRICTED }, resumeOfJobId: 'job-x', actorSub: 'u-nora' });
    expect(ok!.resumeOfJobId).toBe('job-x');
  });

  it('skips jobs a pass already judged', async () => {
    const a = await enqueueJob({ kind: 'devbox:task', title: 'a', payload: { prompt: 'p', initiativeId: RESTRICTED }, actorSub: 'u-nora' });
    expect(await claimNextMicrovmJob({ excludeIds: [a!.id] })).toBeNull();
  });
});

describe('against Aurora', () => {
  beforeEach(() => { cfg.mock.aurora = false; });

  it('the fleet claim carries the runner guard, readable on a cluster without the column', async () => {
    execMock.mockResolvedValueOnce([{ n: 2 }]).mockResolvedValue([]);
    await claimNextJob('box-a', 'session-a');
    expect(execMock.mock.calls.at(-1)[0]).toContain(`COALESCE(to_jsonb(agent_jobs)->>'runner', 'fleet') <> 'microvm'`);
  });

  it('refuses to queue microvm work on a cluster without the runner column, rather than leave it to the fleet', async () => {
    execMock.mockImplementation(async (sql: string) => {
      if (/SELECT devbox_profile_id FROM projects/.test(sql)) return [{ devbox_profile_id: 'restricted' }];
      if (/FROM devbox_profiles/.test(sql)) return [{ id: 'restricted', version: 1, models: '[]', network_class: 'egress-allowlist', org_access: 'none' }];
      if (/information_schema/.test(sql)) return [{ n: 0 }];
      return [];
    });
    await expect(enqueueJob({ kind: 'devbox:task', title: 't', payload: { prompt: 'p', initiativeId: RESTRICTED }, actorSub: 'u-nora' }))
      .rejects.toThrow(/apply schema\/microvm_sessions.sql/);
    expect(execMock.mock.calls.some(([sql]) => /INSERT INTO agent_jobs/.test(sql as string))).toBe(false);
  });

  it('writes runner, actor_sub and resume_of_job_id when the cluster has them', async () => {
    execMock.mockImplementation(async (sql: string) => {
      if (/SELECT devbox_profile_id FROM projects/.test(sql)) return [{ devbox_profile_id: 'restricted' }];
      if (/FROM devbox_profiles/.test(sql)) return [{ id: 'restricted', version: 1, models: '[]', network_class: 'egress-allowlist', org_access: 'none' }];
      if (/information_schema/.test(sql)) return [{ n: 3 }];
      if (/INSERT INTO agent_jobs/.test(sql)) return [{ id: 'job-1', kind: 'devbox:task', title: 't', payload: '{}', status: 'queued', runner: 'microvm', actor_sub: 'u-nora', resume_of_job_id: null }];
      return [];
    });
    const job = await enqueueJob({ kind: 'devbox:task', title: 't', payload: { prompt: 'p', initiativeId: RESTRICTED }, actorSub: 'u-nora' });
    const insert = execMock.mock.calls.find(([sql]) => /INSERT INTO agent_jobs/.test(sql as string))!;
    expect(insert[0]).toMatch(/runner, actor_sub, resume_of_job_id/);
    expect(insert[1]).toEqual(expect.arrayContaining([
      { name: 'runner', value: { stringValue: 'microvm' } }, { name: 'actor_sub', value: { stringValue: 'u-nora' } },
    ]));
    expect(job).toMatchObject({ runner: 'microvm', actorSub: 'u-nora' });
  });
});

describe('the fleet reaper leaves the runner\'s transient boxes alone', () => {
  it('never decides to reap an mvm: box, however old', () => {
    const old = new Date(Date.now() - 10 * 3_600_000).toISOString();
    const box = (id: string): FleetBox => ({ id, label: id, sessionId: `${id}-session`, createdAt: old, status: 'running', lastActivityAt: old, taskStartedAt: old });
    expect(decideReaping([box('mvm:mvm1-abc'), box('fleet-1')]).map((d) => d.box.id)).toEqual(['fleet-1']);
  });
});

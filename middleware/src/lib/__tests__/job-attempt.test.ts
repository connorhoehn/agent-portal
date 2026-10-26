jest.mock('../../providers/agent-jobs.js', () => ({ heartbeatJob: jest.fn() }));
import { heartbeatJob } from '../../providers/agent-jobs.js';
import { maintainJobAttempt } from '../job-attempt.js';
const heartbeat = heartbeatJob as jest.Mock;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
beforeEach(() => heartbeat.mockReset());

it('renews slow accepted work serially and stops without later heartbeats', async () => {
  let active = 0;
  heartbeat.mockImplementation(async () => { expect(++active).toBe(1); await pause(5); active--; return true; });
  const attempt = await maintainJobAttempt('job', 'token', 300);
  try {
    await attempt.run(() => pause(400));
    attempt.assertLive();
    expect(heartbeat.mock.calls.length).toBeGreaterThan(3);
    expect(heartbeat).toHaveBeenCalledWith('job', 'token');
  } finally { attempt.stop(); }
  await pause(10);
  const count = heartbeat.mock.calls.length;
  await pause(70);
  expect(heartbeat).toHaveBeenCalledTimes(count);
});

it('bounds a hung renewal, rejects uncooperative work and never revives on a late reply', async () => {
  let late!: (owned: boolean) => void;
  heartbeat.mockResolvedValueOnce(true).mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
  const attempt = await maintainJobAttempt('job', 'token', 300);
  try {
    await expect(attempt.run(() => new Promise(() => {}))).rejects.toThrow('deadline');
    expect(attempt.signal.aborted).toBe(true);
    late(true);
    await pause(10);
    expect(() => attempt.assertLive()).toThrow('deadline');
    expect(heartbeat).toHaveBeenCalledTimes(2);
  } finally { attempt.stop(); }
});

it('refuses a lost initial claim before the executor can begin', async () => {
  heartbeat.mockResolvedValue(false);
  await expect(maintainJobAttempt('job', 'old', 300)).rejects.toThrow('lost ownership');
  expect(heartbeat).toHaveBeenCalledTimes(1);
});

it('aborts accepted execution on a refused renewal', async () => {
  heartbeat.mockResolvedValueOnce(true).mockResolvedValue(false);
  const attempt = await maintainJobAttempt('job', 'old', 300);
  try { await expect(attempt.run(() => new Promise(() => {}))).rejects.toThrow('lost ownership'); }
  finally { attempt.stop(); }
});

it('does not invoke new work after the attempt has stopped', async () => {
  heartbeat.mockResolvedValue(true);
  const attempt = await maintainJobAttempt('job', 'old', 300);
  attempt.stop();
  const work = jest.fn(async () => 'late');
  await expect(attempt.run(work)).rejects.toThrow('stopped');
  expect(work).not.toHaveBeenCalled();
});

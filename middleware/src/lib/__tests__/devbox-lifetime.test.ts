// DE-48: one lifetime model. The invariants, the env fallback, the one cap,
// claims that respect remaining life, and the reaper cases the spec names
// (a long task on an old reused box is not cut at the old 60-minute ceiling;
// a running box past its own timeout + grace is `task-overrun`; an idle box
// past the ceiling is reaped) — plus DE-40's "the reaper stops a box at its
// PROFILE's max lifetime, not the env default".

import {
  DEFAULT_LIFETIME, AGENTCORE_IDLE_MS, AGENTCORE_MAX_LIFETIME_MS, TASK_MAX_S,
  validateLifetimePolicy, lifetimePolicy, clampTaskTimeout, hasLifeFor, _resetLifetimeWarnings,
  type LifetimePolicy,
} from '../devbox-lifetime.js';
import { decideReaping, sweepOnce, timeLeft } from '../devbox-reaper.js';
import { registerBox, appendEvent, _resetFleet, getBox, type FleetBox } from '../devbox-fleet.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-29T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function box(over: Partial<FleetBox>): FleetBox {
  return {
    id: 'b-1', sessionId: 'devbox-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', label: 'box', status: 'idle',
    createdAt: iso(T0), lastActivityAt: iso(T0), ...over,
  } as FleetBox;
}

describe('lifetime invariants', () => {
  beforeEach(() => { _resetLifetimeWarnings(); jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('the defaults satisfy all three', () => {
    expect(validateLifetimePolicy(DEFAULT_LIFETIME)).toEqual([]);
    const d = DEFAULT_LIFETIME;
    expect(d.taskMaxS * 1000 + d.graceMs).toBeLessThanOrEqual(d.boxCeilingMs);
    expect(d.boxCeilingMs).toBeLessThanOrEqual(AGENTCORE_MAX_LIFETIME_MS);
    expect(d.idleMs).toBeLessThan(AGENTCORE_IDLE_MS);
  });

  it('names each broken invariant', () => {
    const bad: LifetimePolicy = { ...DEFAULT_LIFETIME, boxCeilingMs: 30 * MIN };
    expect(validateLifetimePolicy(bad).join(' ')).toMatch(/exceeds the box ceiling/);
    expect(validateLifetimePolicy({ ...DEFAULT_LIFETIME, boxCeilingMs: 9 * 60 * MIN }).join(' ')).toMatch(/AgentCore maxLifetime/);
    expect(validateLifetimePolicy({ ...DEFAULT_LIFETIME, idleMs: 60 * MIN }).join(' ')).toMatch(/idle stop/);
  });

  it('a bad env combination logs and falls back to the defaults', () => {
    const p = lifetimePolicy(null, { DEVBOX_MAX_LIFETIME_MINUTES: '50', DEVBOX_TASK_MAX_S: '3300' } as NodeJS.ProcessEnv);
    expect(p).toEqual(DEFAULT_LIFETIME);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/unsound env lifetime/));
    expect(lifetimePolicy(null, { DEVBOX_IDLE_TIMEOUT_MINUTES: 'soon' } as NodeJS.ProcessEnv)).toEqual(DEFAULT_LIFETIME);
  });

  it('a sound env override is honoured', () => {
    const p = lifetimePolicy(null, { DEVBOX_IDLE_TIMEOUT_MINUTES: '10', DEVBOX_MAX_LIFETIME_MINUTES: '120' } as NodeJS.ProcessEnv);
    expect(p.idleMs).toBe(10 * MIN);
    expect(p.boxCeilingMs).toBe(120 * MIN);
  });

  it('a profile supplies idle / ceiling / task default, and its task timeout is its ceiling', () => {
    const p = lifetimePolicy({ idle_minutes: 15, max_lifetime_minutes: 90, task_timeout_s: 600 });
    expect(p).toMatchObject({ idleMs: 15 * MIN, boxCeilingMs: 90 * MIN, taskDefaultS: 600, taskMaxS: 600 });
  });
});

describe('the one cap', () => {
  it('clamps to the policy maximum and defaults garbage', () => {
    expect(clampTaskTimeout(99999)).toBe(TASK_MAX_S);
    expect(clampTaskTimeout(undefined)).toBe(DEFAULT_LIFETIME.taskDefaultS);
    expect(clampTaskTimeout('abc')).toBe(DEFAULT_LIFETIME.taskDefaultS);
    expect(clampTaskTimeout(120.7)).toBe(120);
    const tight = lifetimePolicy({ idle_minutes: 20, max_lifetime_minutes: 60, task_timeout_s: 600 });
    expect(clampTaskTimeout(3300, tight)).toBe(600);
  });
});

describe('claims respect remaining life', () => {
  it('skips a box whose remaining ceiling cannot hold one default task plus grace', () => {
    const p = DEFAULT_LIFETIME;
    const fresh = { createdAt: iso(T0) };
    expect(hasLifeFor(fresh, p, T0 + 60 * MIN)).toBe(true);
    // 4 h ceiling − 14 min task − 5 min grace = 221 min of age is the last claimable minute.
    expect(hasLifeFor(fresh, p, T0 + 221 * MIN)).toBe(true);
    expect(hasLifeFor(fresh, p, T0 + 222 * MIN)).toBe(false);
  });
});

describe('the reaper under one lifetime model', () => {
  it('a 50-minute-old idle box that starts a 3300 s task is not reaped at 60 minutes', () => {
    const b = box({ status: 'running', createdAt: iso(T0), taskStartedAt: iso(T0 + 50 * MIN), lastActivityAt: iso(T0 + 50 * MIN) });
    expect(decideReaping([b], T0 + 60 * MIN)).toEqual([]);
    // Still inside 55 min + 5 min grace from the task's start.
    expect(decideReaping([b], T0 + 50 * MIN + 59 * MIN)).toEqual([]);
  });

  it('a running box past taskMaxS + grace is reaped as task-overrun', () => {
    const b = box({ status: 'running', taskStartedAt: iso(T0) });
    const [d] = decideReaping([b], T0 + (TASK_MAX_S * 1000) + 5 * MIN);
    expect(d).toMatchObject({ reason: 'task-overrun', minutes: 60 });
  });

  it('an idle box past boxCeilingMs is reaped as max-lifetime', () => {
    const b = box({ lastActivityAt: iso(T0 + 239 * MIN) });
    expect(decideReaping([b], T0 + 239 * MIN + 1)).toEqual([]);
    expect(decideReaping([b], T0 + 240 * MIN)[0]).toMatchObject({ reason: 'max-lifetime' });
  });

  it('a running box is never reaped for idleness or box age', () => {
    const b = box({ status: 'running', createdAt: iso(T0 - 300 * MIN), taskStartedAt: iso(T0), lastActivityAt: iso(T0 - 100 * MIN) });
    expect(decideReaping([b], T0 + 30 * MIN)).toEqual([]);
  });

  it('timeLeft reports taskMsLeft for a running box', () => {
    const b = box({ status: 'running', taskStartedAt: iso(T0) });
    const t = timeLeft(b, T0 + 10 * MIN);
    expect(t.taskMsLeft).toBe(TASK_MAX_S * 1000 + 5 * MIN - 10 * MIN);
    expect(t.stopsInMs).toBe(t.taskMsLeft);
  });

  it('task_started stamps taskStartedAt on the fleet row', () => {
    _resetFleet();
    const b = registerBox({ sessionId: 'devbox-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    appendEvent(b.id, { type: 'task_started', prompt: 'go' });
    expect(getBox(b.id)?.taskStartedAt).toEqual(expect.any(String));
    expect(getBox(b.id)?.status).toBe('running');
  });
});

describe('the reaper reads the box\'s profile (DE-40)', () => {
  beforeEach(() => _resetFleet());

  it('stops a box at its profile\'s max lifetime, not the env default', async () => {
    const created = Date.now() - 50 * MIN;
    const b = registerBox({ sessionId: 'devbox-ccccccccccccccccccccccccccccccccc', createdAt: iso(created), profile: { id: 'short', version: 1 } });
    // Keep it from looking idle: the profile's ceiling is what must fire.
    const live = getBox(b.id)!;
    live.lastActivityAt = new Date().toISOString();
    const short = lifetimePolicy({ idle_minutes: 30, max_lifetime_minutes: 45, task_timeout_s: 600 });
    const send = jest.fn(async () => ({}));
    const decisions = await sweepOnce({
      client: () => ({ send }) as never,
      runtimeArn: async () => 'arn:devbox',
      policies: async (boxes) => new Map(boxes.map((x) => [x.id, short])),
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ reason: 'max-lifetime' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(getBox(b.id)?.status).toBe('stopped');

    // The same box under the env default (4 h) would not have been touched.
    expect(decideReaping([{ ...live, status: 'idle' }], Date.now())).toEqual([]);
  });
});

// "Starting soon" (row I5.6): the pure window (soon.ts), the tick that rings (soon-sweep.ts) and the bell's words.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
jest.mock('../../role-registry.js', () => ({ roleRegistry: () => [] }));

import { dueRings, resetSoonWarnings, ringKey, SOON_MINUTES, SOON_MINUTES_SETTING, soonMinutes } from '../soon.js';
import { runSoonTick } from '../soon-sweep.js';
import { notifyInterviewStartingSoon, setNotificationSink, type NotificationInputLike } from '../../social-notify.js';
import type { Interview } from '../types.js';

const NOW = Date.parse('2026-12-01T10:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const iv = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-1', applicationId: 'ap-1', roundId: 'r-1', type: 'technical', leadId: 'u-lead', panelIds: ['u-p1'], scheduledAt: at(10), minutes: 45,
  state: 'accepted', questionIds: [], assignedBy: 'u-rec', assignedAt: at(-100), callId: null, endedAt: null, acceptances: [], declines: [], revision: 1, ...over,
});
const users = (rings: ReturnType<typeof dueRings>) => rings.map((r) => r.userId).sort();

describe('dueRings', () => {
  it('rings the lead and the panel inside the window, for both accepted and ready', () => {
    expect(users(dueRings([iv()], NOW, new Set()))).toEqual(['u-lead', 'u-p1']);
    expect(dueRings([iv({ state: 'ready' })], NOW, new Set())).toHaveLength(2);
  });
  it('the edges: exactly the window is in, a minute more or the start itself is out', () => {
    expect(dueRings([iv({ scheduledAt: at(SOON_MINUTES) })], NOW, new Set())).toHaveLength(2);
    expect(dueRings([iv({ scheduledAt: at(SOON_MINUTES + 1) })], NOW, new Set())).toHaveLength(0);
    expect(dueRings([iv({ scheduledAt: at(0) })], NOW, new Set())).toHaveLength(0);
    expect(dueRings([iv({ scheduledAt: at(-5) })], NOW, new Set())).toHaveLength(0);
  });
  it('never rings a cleared time, a declined, cancelled, live or unanswered round', () => {
    expect(dueRings([iv({ scheduledAt: null })], NOW, new Set())).toHaveLength(0);
    for (const state of ['declined', 'cancelled', 'live', 'assigned', 'ended'] as const) expect(dueRings([iv({ state })], NOW, new Set())).toHaveLength(0);
  });
  it('rings once per time: a rung person is skipped, a moved time rings again, a new panel member gets their own', () => {
    const rung = new Set([ringKey('iv-1', 'u-lead', at(10)), ringKey('iv-1', 'u-p1', at(10))]);
    expect(dueRings([iv()], NOW, rung)).toHaveLength(0);
    expect(dueRings([iv({ scheduledAt: at(12) })], NOW, rung)).toHaveLength(2);
    expect(users(dueRings([iv({ panelIds: ['u-p1', 'u-p2'] })], NOW, rung))).toEqual(['u-p2']);
  });
});

describe('runSoonTick', () => {
  const world = { openings: [{ id: 'op-1', title: 'Data Engineer', kit: { rounds: [{ id: 'r-1', name: 'System design' }] } }], applications: [{ id: 'ap-1', openingId: 'op-1' }], interviews: [iv()] };
  const base = () => { const ring = jest.fn(async () => []); return { ring, deps: { now: () => NOW, load: async () => world as never, ring, enabled: () => true } }; };

  it('rings a due round once, however many ticks run, naming the opening and the round only', async () => {
    const { ring, deps } = base();
    const keys = new Set<string>();
    expect(await runSoonTick(deps, keys)).toBe(2);
    expect(await runSoonTick(deps, keys)).toBe(0);
    expect(ring).toHaveBeenCalledTimes(1);
    expect(ring).toHaveBeenCalledWith(expect.objectContaining({ interviewId: 'iv-1', openingTitle: 'Data Engineer', roundName: 'System design', userIds: ['u-lead', 'u-p1'] }));
  });
  it('does nothing while the interviews flag is off', async () => {
    const { ring, deps } = base();
    expect(await runSoonTick({ ...deps, enabled: () => false }, new Set())).toBe(0);
    expect(ring).not.toHaveBeenCalled();
  });
  it('forgets keys whose start has passed', async () => {
    const { deps } = base();
    const keys = new Set([ringKey('iv-9', 'u-x', at(-30))]);
    await runSoonTick(deps, keys);
    expect([...keys].some((k) => k.startsWith('iv-9'))).toBe(false);
  });
});

describe('INTERVIEWS_SOON_MINUTES (row I6.4)', () => {
  beforeEach(() => resetSoonWarnings());
  const read = (value: string | undefined) => { const lines: string[] = []; const n = soonMinutes(value === undefined ? {} : { [SOON_MINUTES_SETTING]: value }, (l) => lines.push(l)); return { n, lines }; };

  it('defaults to 15 when unset or empty, without a warning', () => {
    expect(read(undefined)).toEqual({ n: 15, lines: [] });
    expect(read('  ')).toEqual({ n: 15, lines: [] });
    expect(SOON_MINUTES).toBe(15);
  });
  it('takes a whole number from 5 to 120', () => {
    expect(read('5').n).toBe(5);
    expect(read(' 30 ').n).toBe(30);
    expect(read('120').n).toBe(120);
  });
  it('falls back to 15 for a bad or out-of-range value, warning once per value and never throwing', () => {
    for (const bad of ['4', '121', '0', '-10', '7.5', 'ten', '1e2', '0x10']) {
      const r = read(bad);
      expect(r.n).toBe(15);
      expect(r.lines).toEqual([`[interviews] ${SOON_MINUTES_SETTING} must be a whole number from 5 to 120; using the default, 15.`]);
    }
    expect(read('121').lines).toEqual([]);
  });
  it('the tick rings at the deployment\'s lead and says that number', async () => {
    const world = { openings: [{ id: 'op-1', title: 'Data Engineer', kit: { rounds: [{ id: 'r-1', name: 'System design' }] } }], applications: [{ id: 'ap-1', openingId: 'op-1' }] };
    for (const minutes of [5, 15, 120]) {
      const inside = iv({ id: `iv-in-${minutes}`, scheduledAt: at(minutes) });
      const outside = iv({ id: `iv-out-${minutes}`, scheduledAt: at(minutes + 1) });
      const ring = jest.fn(async () => []);
      const sent = await runSoonTick({ now: () => NOW, load: async () => ({ ...world, interviews: [inside, outside] }) as never, ring, enabled: () => true, minutes: () => minutes }, new Set());
      expect(sent).toBe(2);
      expect(ring).toHaveBeenCalledTimes(1);
      expect(ring).toHaveBeenCalledWith(expect.objectContaining({ interviewId: `iv-in-${minutes}`, minutes }));
    }
  });
  it('the tick reads the setting on every pass', async () => {
    const before = process.env[SOON_MINUTES_SETTING];
    try {
      process.env[SOON_MINUTES_SETTING] = '60';
      const ring = jest.fn(async () => []);
      const world = { openings: [{ id: 'op-1', title: 'Data Engineer', kit: { rounds: [{ id: 'r-1', name: 'System design' }] } }], applications: [{ id: 'ap-1', openingId: 'op-1' }], interviews: [iv({ scheduledAt: at(45) })] };
      expect(await runSoonTick({ now: () => NOW, load: async () => world as never, ring, enabled: () => true }, new Set())).toBe(2);
      expect(ring).toHaveBeenCalledWith(expect.objectContaining({ minutes: 60 }));
    } finally {
      if (before === undefined) delete process.env[SOON_MINUTES_SETTING]; else process.env[SOON_MINUTES_SETTING] = before;
    }
  });
});

describe('notifyInterviewStartingSoon', () => {
  let sent: Array<{ userId: string; input: NotificationInputLike }>;
  beforeEach(() => { sent = []; setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } }); });
  afterEach(() => setNotificationSink(null));

  it('says the round, the opening and the minutes, with the same id for the same time and a new one for a moved time', async () => {
    const ev = { interviewId: 'iv-1', scheduledAt: at(10), minutes: 15, openingTitle: 'Data Engineer', roundName: 'System design', userIds: ['u-hugo', 'u-jonas'] };
    await notifyInterviewStartingSoon(ev);
    await notifyInterviewStartingSoon(ev);
    await notifyInterviewStartingSoon({ ...ev, scheduledAt: at(12) });
    expect(sent.map((x) => x.userId)).toEqual(['u-hugo', 'u-hugo', 'u-hugo']); // u-jonas holds no interviews grant
    for (const s of sent) {
      expect(s.input.title).toBe('System design for Data Engineer starts in 15 minutes');
      expect(s.input.payload).toMatchObject({ tenant: 'interviews', kind: 'interview-starting-soon', audience: 'interviewer' });
      expect(JSON.stringify(s.input)).not.toContain('iv-1');
    }
    expect(sent[0]!.input.id).toBe(sent[1]!.input.id);
    expect(sent[2]!.input.id).not.toBe(sent[0]!.input.id);
  });
  it('says the deployment\'s lead: 5 and 120 minutes', async () => {
    const ev = { interviewId: 'iv-1', scheduledAt: at(10), openingTitle: 'Data Engineer', roundName: 'System design', userIds: ['u-hugo'] };
    await notifyInterviewStartingSoon({ ...ev, minutes: 5 });
    await notifyInterviewStartingSoon({ ...ev, scheduledAt: at(11), minutes: 120 });
    expect(sent.map((x) => x.input.title)).toEqual(['System design for Data Engineer starts in 5 minutes', 'System design for Data Engineer starts in 120 minutes']);
  });
});

// Hardening (H1, O-042 and O-043).
describe('a busy tick and a restart', () => {
  const many = (n: number) => Array.from({ length: n }, (_, k) => iv({ id: `iv-${k}`, leadId: `u-lead-${k}`, panelIds: [] }));
  const worldOf = (rows: Interview[]) => ({ openings: [{ id: 'op-1', title: 'Data Engineer', kit: { rounds: [{ id: 'r-1', name: 'System design' }] } }], applications: [{ id: 'ap-1', openingId: 'op-1' }], interviews: rows });

  it('rings at most 200 in one tick and the rest on the next, each person once (O-042)', async () => {
    const ring = jest.fn(async () => []);
    const deps = { now: () => NOW, load: async () => worldOf(many(450)) as never, ring, enabled: () => true };
    const keys = new Set<string>();
    expect(await runSoonTick(deps, keys)).toBe(200);
    expect(await runSoonTick(deps, keys)).toBe(200);
    expect(await runSoonTick(deps, keys)).toBe(50);
    expect(await runSoonTick(deps, keys)).toBe(0);
    const told = ring.mock.calls.flatMap((c) => (c as unknown as Array<{ userIds: string[] }>)[0]!.userIds);
    expect(told).toHaveLength(450);
    expect(new Set(told).size).toBe(450);
  });

  // The set of what was rung lives in memory, so a restart inside the window rings the same person for the same time
  // again under the SAME bell id. The ledger says the real notification store drops that repeat. It does not: the
  // store (realtime-modules RedisNotificationStore) keeps each record as its own sorted-set member, and a record's
  // timestamp differs between the two rings. Left failing so the checklist stays honest (a finding for the lead).
  it.failing('after a restart the real notification store holds one bell for one person and one time (O-043)', async () => {
    const { RedisNotificationStore } = await import('@connorhoehn/realtime-modules/notification');
    const zsets = new Map<string, Map<string, number>>();
    const redis = {
      zAdd: async (key: string, e: { score: number; value: string }) => { (zsets.get(key) ?? zsets.set(key, new Map()).get(key)!).set(e.value, e.score); },
      zRemRangeByRank: async () => 0, expire: async () => 1, hGetAll: async () => ({}), hSet: async () => 1,
      zRange: async (key: string) => [...(zsets.get(key) ?? new Map<string, number>()).entries()].sort((a, b) => a[1] - b[1]).map(([v]) => v),
    };
    const store = new RedisNotificationStore({ redisClient: redis as never, logger: { error() {}, warn() {}, info() {}, debug() {} } as never });
    let tick = Date.parse('2026-12-01T10:00:00.000Z');
    setNotificationSink({ notifyUser: async (userId, input) => { await store.append(userId, { ...input, type: 'system', timestamp: new Date(tick++).toISOString() } as never); return {}; } });
    try {
      const deps = { now: () => NOW, load: async () => ({ openings: [], applications: [], interviews: [iv({ leadId: 'u-hugo', panelIds: [] })] }) as never, enabled: () => true };
      await runSoonTick(deps, new Set<string>());   // the first run
      await runSoonTick(deps, new Set<string>());   // the process restarted: nothing remembered
      expect((await store.list('u-hugo')).filter((r) => /starts in/.test(r.title))).toHaveLength(1);
    } finally { setNotificationSink(null); }
  });
});

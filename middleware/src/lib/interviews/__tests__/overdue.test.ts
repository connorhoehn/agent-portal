// The overdue-scorecard reminder (ledger row C-17): the pure rule (overdue.ts), the tick (overdue-sweep.ts) and the bell.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
jest.mock('../../role-registry.js', () => ({ roleRegistry: () => [] }));

import { dueOverdue, OVERDUE_HOURS, OVERDUE_HOURS_SETTING, overdueHours, overdueKey, resetOverdueWarnings } from '../overdue.js';
import { runOverdueTick } from '../overdue-sweep.js';
import { notifyInterviewScorecardOverdue, setNotificationSink, type NotificationInputLike } from '../../social-notify.js';
import type { Interview } from '../types.js';

const NOW = Date.parse('2026-12-02T10:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const iv = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-1', applicationId: 'ap-1', roundId: 'r-1', type: 'technical', leadId: 'u-hugo', panelIds: ['u-wen'], scheduledAt: hoursAgo(26), minutes: 60,
  state: 'ended', questionIds: [], assignedBy: 'u-greta', assignedAt: hoursAgo(100), callId: null, endedAt: hoursAgo(25), acceptances: [], declines: [], revision: 3, ...over,
});
const card = (interviewerId: string, interviewId = 'iv-1') => ({ interviewId, interviewerId });
const users = (rings: ReturnType<typeof dueOverdue>) => rings.map((r) => r.userId).sort();
const world = (interviews: Interview[], scorecards: Array<{ interviewId: string; interviewerId: string }> = []) =>
  ({ openings: [{ id: 'op-1', title: 'Data Engineer', kit: { rounds: [{ id: 'r-1', name: 'System design' }] } }], applications: [{ id: 'ap-1', openingId: 'op-1' }], interviews, scorecards });

describe('dueOverdue', () => {
  it('rings each seat of an ended round once the delay has passed since its end, and not a moment before', () => {
    expect(users(dueOverdue([iv()], [], NOW, new Set()))).toEqual(['u-hugo', 'u-wen']);
    expect(dueOverdue([iv({ endedAt: hoursAgo(24) })], [], NOW, new Set())).toHaveLength(2);
    expect(dueOverdue([iv({ endedAt: new Date(NOW - 24 * 3_600_000 + 1).toISOString() })], [], NOW, new Set())).toHaveLength(0);
  });
  it('only the seats that owe: a seat that submitted is not rung', () => {
    expect(users(dueOverdue([iv()], [card('u-hugo')], NOW, new Set()))).toEqual(['u-wen']);
    expect(dueOverdue([iv()], [card('u-hugo'), card('u-wen')], NOW, new Set())).toHaveLength(0);
    expect(users(dueOverdue([iv()], [card('u-hugo', 'iv-other')], NOW, new Set()))).toEqual(['u-hugo', 'u-wen']);
  });
  it('never for a cancelled round, nor one still to run, live, scored or reviewed, nor one without an end', () => {
    for (const state of ['cancelled', 'declined', 'assigned', 'accepted', 'ready', 'live', 'scored', 'reviewed'] as const) {
      expect(dueOverdue([iv({ state })], [], NOW, new Set())).toHaveLength(0);
    }
    expect(dueOverdue([iv({ endedAt: null })], [], NOW, new Set())).toHaveLength(0);
  });
  it('a rung seat is skipped', () => {
    const e = iv().endedAt!;
    expect(users(dueOverdue([iv()], [], NOW, new Set([overdueKey('iv-1', 'u-hugo', e)])))).toEqual(['u-wen']);
  });
  it('follows the deployment\'s delay', () => {
    expect(dueOverdue([iv({ endedAt: hoursAgo(3) })], [], NOW, new Set(), 2)).toHaveLength(2);
    expect(dueOverdue([iv({ endedAt: hoursAgo(3) })], [], NOW, new Set(), 4)).toHaveLength(0);
  });
});

describe('runOverdueTick', () => {
  const base = (w = world([iv()])) => { const ring = jest.fn(async () => []); return { ring, deps: { now: () => NOW, load: async () => w as never, ring, enabled: () => true, hours: () => OVERDUE_HOURS } }; };

  it('rings an overdue round once, however many ticks run, naming the opening and the round only', async () => {
    const { ring, deps } = base();
    const keys = new Set<string>();
    expect(await runOverdueTick(deps, keys)).toBe(2);
    expect(await runOverdueTick(deps, keys)).toBe(0);
    expect(ring).toHaveBeenCalledTimes(1);
    expect(ring).toHaveBeenCalledWith({ interviewId: 'iv-1', hours: 24, openingTitle: 'Data Engineer', roundName: 'System design', userIds: ['u-hugo', 'u-wen'] });
  });
  it('never after the round is cancelled, and forgets its keys', async () => {
    const keys = new Set([overdueKey('iv-1', 'u-hugo', hoursAgo(25))]);
    const { ring, deps } = base(world([iv({ state: 'cancelled' })]));
    expect(await runOverdueTick(deps, keys)).toBe(0);
    expect(ring).not.toHaveBeenCalled();
    expect(keys.size).toBe(0);
  });
  it('does nothing while the interviews flag is off', async () => {
    const { ring, deps } = base();
    expect(await runOverdueTick({ ...deps, enabled: () => false }, new Set())).toBe(0);
    expect(ring).not.toHaveBeenCalled();
  });
  it('never throws: a failed load rings nothing', async () => {
    const { ring, deps } = base();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await runOverdueTick({ ...deps, load: async () => { throw new Error('down'); } }, new Set())).toBe(0);
    expect(ring).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('INTERVIEWS_SCORECARD_OVERDUE_HOURS', () => {
  beforeEach(() => resetOverdueWarnings());
  const read = (value: string | undefined) => { const lines: string[] = []; const n = overdueHours(value === undefined ? {} : { [OVERDUE_HOURS_SETTING]: value }, (l) => lines.push(l)); return { n, lines }; };
  it('defaults to 24; takes a whole number from 1 to 336; falls back once per bad value', () => {
    expect(read(undefined)).toEqual({ n: 24, lines: [] });
    expect(read('1').n).toBe(1);
    expect(read(' 48 ').n).toBe(48);
    expect(read('336').n).toBe(336);
    for (const bad of ['0', '337', '-2', '1.5', 'day']) {
      const r = read(bad);
      expect(r.n).toBe(24);
      expect(r.lines).toEqual([`[interviews] ${OVERDUE_HOURS_SETTING} must be a whole number from 1 to 336; using the default, 24.`]);
    }
    expect(read('337').lines).toEqual([]);
  });
});

describe('notifyInterviewScorecardOverdue', () => {
  let sent: Array<{ userId: string; input: NotificationInputLike }>;
  beforeEach(() => { sent = []; setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } }); });
  afterEach(() => setNotificationSink(null));

  it('says the opening and the round are overdue, opens the scorecard, and never names the candidate', async () => {
    await notifyInterviewScorecardOverdue({ interviewId: 'iv-1', hours: 24, openingTitle: 'Data Engineer', roundName: 'System design', userIds: ['u-hugo'] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.title).toBe('Your scorecard is overdue: System design for Data Engineer');
    expect(sent[0]!.input.body).toMatch(/more than a day ago/);
    expect(sent[0]!.input.action).toEqual({ label: 'Open the scorecard', href: '/interviews/rounds/iv-1/scorecard' });
    expect(sent[0]!.input.payload).toMatchObject({ tenant: 'interviews', kind: 'interview-scorecard-overdue', audience: 'interviewer' });
  });

  // The rung keys live in memory, so a restart would ring again; the bell's id (round, person) is read back from the inbox.
  it('after a restart the real notification store holds one reminder for one person and one round', async () => {
    const { RedisNotificationStore } = await import('@connorhoehn/realtime-modules/notification');
    const zsets = new Map<string, Map<string, number>>();
    const redis = {
      zAdd: async (key: string, e: { score: number; value: string }) => { (zsets.get(key) ?? zsets.set(key, new Map()).get(key)!).set(e.value, e.score); },
      zRemRangeByRank: async () => 0, expire: async () => 1, hGetAll: async () => ({}), hSet: async () => 1,
      zRange: async (key: string) => [...(zsets.get(key) ?? new Map<string, number>()).entries()].sort((a, b) => a[1] - b[1]).map(([v]) => v),
    };
    const store = new RedisNotificationStore({ redisClient: redis as never, logger: { error() {}, warn() {}, info() {}, debug() {} } as never });
    let tick = NOW;
    setNotificationSink({
      notifyUser: async (userId, input) => { await store.append(userId, { ...input, type: 'system', timestamp: new Date(tick++).toISOString() } as never); return {}; },
      listForUser: (userId) => store.list(userId) as never,
    });
    const deps = { now: () => NOW, load: async () => world([iv({ panelIds: [] })]) as never, enabled: () => true, hours: () => 24 };
    await runOverdueTick(deps, new Set<string>());   // the first run
    await runOverdueTick(deps, new Set<string>());   // the process restarted: nothing remembered
    expect((await store.list('u-hugo')).filter((r) => /overdue/.test(r.title))).toHaveLength(1);
  });
});

// "Starting soon" (row I5.6): the pure window (soon.ts), the tick that rings (soon-sweep.ts) and the bell's words.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
jest.mock('../../role-registry.js', () => ({ roleRegistry: () => [] }));

import { dueRings, ringKey, SOON_MINUTES } from '../soon.js';
import { runSoonTick } from '../soon-sweep.js';
import { notifyInterviewStartingSoon, setNotificationSink, type NotificationInputLike } from '../../social-notify.js';
import type { Interview } from '../types.js';

const NOW = Date.parse('2026-12-01T10:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const iv = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-1', applicationId: 'ap-1', roundId: 'r-1', type: 'technical', leadId: 'u-lead', panelIds: ['u-p1'], scheduledAt: at(10), minutes: 45,
  state: 'accepted', questionIds: [], assignedBy: 'u-rec', assignedAt: at(-100), inviteTokenHash: null, callId: null, endedAt: null, acceptances: [], declines: [], revision: 1, ...over,
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
});

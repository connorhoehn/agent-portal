// Assigning a round, answering a seat and reassigning (docs/interviews-tenant-plan.md row I1.4): the rules,
// pure, over the seed world.
import { fixtureRegistry } from '../../../mock/core/index.js';
import { HUGO, WEN, interviewApplicationsFixture, interviewOpeningsFixture, interviewsFixture } from '../../../mock/interviews.js';
import {
  ASSIGN_LIMITS, answerSeat, applyReassignment, assignProblemsLine, checkAnswer, checkAssignment, checkReassignment, interviewIdFor, newInterview,
  newlySeated,
} from '../assign.js';
import type { Interview } from '../types.js';

const THIRD = 'u-third';
const INTERVIEWERS = new Set([HUGO, WEN, THIRD]);
const world = () => ({ applications: interviewApplicationsFixture.rows(), openings: interviewOpeningsFixture.rows(), interviews: interviewsFixture.rows() });
const paths = (r: { ok: boolean; problems?: Array<{ path: string }> }) => (r.ok ? [] : r.problems!.map((p) => p.path));
const AT = '2026-11-16T10:00:00.000Z';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('assigning a round', () => {
  // Lucía is in screening for the backend opening and has no round yet.
  const good = { applicationId: 'app-g393z287', roundId: 'rd-coding', leadId: HUGO, panelIds: [WEN] };

  it('a good assignment is cleaned and becomes an assigned interview with no time', () => {
    const r = checkAssignment({ ...good, roundId: ' rd-coding ', extra: 1 }, world(), INTERVIEWERS);
    expect(r).toEqual({ ok: true, value: good });
    const opening = interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!;
    const iv = newInterview(good, opening, 'iv-abc', 'u-greta', AT);
    expect(iv).toMatchObject({ state: 'assigned', scheduledAt: null, type: 'technical', minutes: 60, leadId: HUGO, panelIds: [WEN], acceptances: [], declines: [], revision: 1 });
  });

  it('the application must exist and still be moving, on an open opening', () => {
    expect(paths(checkAssignment({ ...good, applicationId: 'app-nowhere' }, world(), INTERVIEWERS))).toEqual(['applicationId']);
    expect(paths(checkAssignment({ ...good, applicationId: 'app-y2pmbks8' }, world(), INTERVIEWERS))).toEqual(['applicationId']);
    const w = world();
    w.openings = w.openings.map((o) => (o.id === 'op-backend' ? { ...o, state: 'paused' as const } : o));
    const r = checkAssignment(good, w, INTERVIEWERS);
    expect(r.ok ? '' : r.problems[0]!.message).toBe('This opening is not open, so its rounds cannot be assigned. Open it again first.');
  });

  it('the round must be one of the opening\'s, and not already held for this candidate', () => {
    expect(paths(checkAssignment({ ...good, roundId: 'rd-leadership' }, world(), INTERVIEWERS))).toEqual(['roundId']);
    expect(paths(checkAssignment({ ...good, roundId: '' }, world(), INTERVIEWERS))).toEqual(['roundId']);
    expect(paths(checkAssignment({ ...good, applicationId: 'app-pn7v4yev' }, world(), INTERVIEWERS))).toEqual(['roundId']);
  });

  it('a declined or cancelled round does not hold it: it may be assigned again', () => {
    const w = world();
    w.interviews = w.interviews.map((i) => (i.id === 'iv-h4m7c3vu' || i.id === 'iv-s4e8u2zk' ? { ...i, state: 'declined' as const } : i));
    expect(checkAssignment({ ...good, applicationId: 'app-pn7v4yev' }, w, INTERVIEWERS).ok).toBe(true);
  });

  it('a finished round does not hold it either: a second round of the same kind may follow, but not while one is to come', () => {
    const w = world();
    w.interviews = w.interviews.map((i) => (i.id === 'iv-h4m7c3vu' || i.id === 'iv-s4e8u2zk' ? { ...i, state: 'scored' as const } : i));
    expect(checkAssignment({ ...good, applicationId: 'app-pn7v4yev' }, w, INTERVIEWERS).ok).toBe(true);
    w.interviews = w.interviews.map((i) => (i.id === 'iv-s4e8u2zk' ? { ...i, state: 'ready' as const } : i));
    expect(paths(checkAssignment({ ...good, applicationId: 'app-pn7v4yev' }, w, INTERVIEWERS))).toEqual(['roundId']);
  });

  it('the lead and the panel are interviewers here: at most two more, never the lead, never twice', () => {
    expect(paths(checkAssignment({ ...good, leadId: '' }, world(), INTERVIEWERS))).toEqual(['leadId']);
    expect(paths(checkAssignment({ ...good, leadId: 'u-amara' }, world(), INTERVIEWERS))).toEqual(['leadId']);
    expect(paths(checkAssignment({ ...good, panelIds: [HUGO] }, world(), INTERVIEWERS))).toEqual(['panelIds.0']);
    expect(paths(checkAssignment({ ...good, panelIds: [WEN, WEN] }, world(), INTERVIEWERS))).toEqual(['panelIds.1']);
    expect(paths(checkAssignment({ ...good, panelIds: ['u-greta'] }, world(), INTERVIEWERS))).toEqual(['panelIds.0']);
    expect(paths(checkAssignment({ ...good, panelIds: 'u-wen' }, world(), INTERVIEWERS))).toEqual(['panelIds']);
    expect(paths(checkAssignment({ ...good, panelIds: [WEN, THIRD, 'u-fourth'] }, world(), new Set([...INTERVIEWERS, 'u-fourth'])))).toEqual(['panelIds']);
    expect(checkAssignment({ ...good, panelIds: [WEN, THIRD] }, world(), INTERVIEWERS).ok).toBe(true);
  });

  it('every refusal is one plain sentence per field', () => {
    const r = checkAssignment({}, world(), INTERVIEWERS);
    expect(r.ok).toBe(false);
    for (const p of r.ok ? [] : r.problems) expect(p.message).toMatch(/^[A-Z][^\n]*\.$/);
    expect(assignProblemsLine('assign', 1)).toBe('The round was not assigned: one thing needs fixing.');
  });

  it('a new id says nothing about the candidate, fits the pad\'s channel, and is never one already taken', () => {
    const id = interviewIdFor(new Set());
    expect(id).toMatch(/^iv-[a-z0-9]{12}$/);
    expect(id.length).toBeLessThanOrEqual(ASSIGN_LIMITS.id);
    const picks = ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'];
    expect(interviewIdFor(new Set(['iv-aaaaaaaaaaaa']), () => picks.shift()!)).toBe('iv-bbbbbbbbbbbb');
  });
});

describe('answering a seat', () => {
  const fresh = (): Interview => ({ ...newInterview({ applicationId: 'app-g393z287', roundId: 'rd-coding', leadId: HUGO, panelIds: [WEN, THIRD] },
    interviewOpeningsFixture.rows().find((o) => o.id === 'op-backend')!, 'iv-x', 'u-greta', AT) });
  const apply = (i: Interview, change: object): Interview => ({ ...i, ...change });

  it('the lead accepting moves assigned to accepted', () => {
    const r = answerSeat(fresh(), HUGO, { answer: 'accept' }, AT);
    expect(r).toMatchObject({ ok: true, seat: 'lead', change: { state: 'accepted', acceptances: [{ userId: HUGO, seat: 'lead', at: AT }] } });
  });

  it('a panel member accepting is recorded on their seat; the state does not move', () => {
    const r = answerSeat(fresh(), WEN, { answer: 'accept' }, AT);
    expect(r).toMatchObject({ ok: true, seat: 'panel', change: { state: 'assigned', panelIds: [WEN, THIRD], acceptances: [{ userId: WEN, seat: 'panel' }] } });
  });

  it('the lead declining moves it to declined and keeps the reason; the lead stays named', () => {
    const r = answerSeat(fresh(), HUGO, { answer: 'decline', reason: 'On leave that whole week.' }, AT);
    expect(r).toMatchObject({ ok: true, change: { state: 'declined', declines: [{ userId: HUGO, seat: 'lead', reason: 'On leave that whole week.' }] } });
  });

  it('a panel member declining leaves the panel with the reason kept; the state does not move', () => {
    let i = fresh();
    i = apply(i, (answerSeat(i, WEN, { answer: 'accept' }, AT) as { change: object }).change);
    const r = answerSeat(i, THIRD, { answer: 'decline', reason: 'I interviewed this person last year.' }, AT);
    expect(r).toMatchObject({ ok: true, change: { state: 'assigned', panelIds: [WEN], acceptances: [{ userId: WEN }], declines: [{ userId: THIRD, seat: 'panel' }] } });
  });

  it('nobody answers twice, nobody answers a seat they do not hold, nothing once the call has started or the round is closed', () => {
    let i = fresh();
    i = apply(i, (answerSeat(i, HUGO, { answer: 'accept' }, AT) as { change: object }).change);
    expect(answerSeat(i, HUGO, { answer: 'accept' }, AT)).toMatchObject({ ok: false, reason: 'answered' });
    expect(answerSeat(i, HUGO, { answer: 'decline', reason: 'Changed my mind after all.' }, AT)).toMatchObject({ ok: false, reason: 'answered' });
    expect(answerSeat(i, 'u-greta', { answer: 'accept' }, AT)).toMatchObject({ ok: false, reason: 'no-seat' });
    expect(answerSeat({ ...i, state: 'live' }, WEN, { answer: 'accept' }, AT)).toMatchObject({ ok: false, reason: 'closed' });
    expect(answerSeat({ ...i, state: 'declined' }, WEN, { answer: 'accept' }, AT)).toMatchObject({ ok: false, reason: 'closed' });
    expect(answerSeat({ ...i, state: 'cancelled' }, WEN, { answer: 'accept' }, AT)).toMatchObject({ ok: false, reason: 'closed' });
    // A panel member who declined has no seat left to answer.
    const out = apply(i, (answerSeat(i, THIRD, { answer: 'decline', reason: 'Clashes with on-call that week.' }, AT) as { change: object }).change);
    expect(answerSeat(out, THIRD, { answer: 'accept' }, AT)).toMatchObject({ ok: false, reason: 'no-seat' });
  });

  it('a decline needs a reason between the floor and the ceiling', () => {
    expect(checkAnswer({ answer: 'accept', reason: 'ignored' })).toEqual({ ok: true, value: { answer: 'accept' } });
    expect(paths(checkAnswer({ answer: 'decline' }))).toEqual(['reason']);
    expect(paths(checkAnswer({ answer: 'decline', reason: 'busy' }))).toEqual(['reason']);
    expect(paths(checkAnswer({ answer: 'decline', reason: 'x'.repeat(ASSIGN_LIMITS.reasonMax + 1) }))).toEqual(['reason']);
    expect(checkAnswer({ answer: 'decline', reason: '  Out   that week.  ' })).toEqual({ ok: true, value: { answer: 'decline', reason: 'Out that week.' } });
    expect(paths(checkAnswer({ answer: 'maybe' }))).toEqual(['answer']);
  });
});

describe('reassigning', () => {
  const declined = (): Interview => ({ ...interviewsFixture.rows().find((i) => i.id === 'iv-h4m7c3vu')!, state: 'declined',
    declines: [{ userId: HUGO, seat: 'lead', reason: 'On leave that whole week.', at: AT }] });

  it('a declined round needs a new lead, who puts it back to assigned; the decline stays on the record', () => {
    expect(paths(checkReassignment({ leadId: HUGO, panelIds: [] }, declined(), INTERVIEWERS))).toEqual(['leadId']);
    const r = checkReassignment({ leadId: WEN, panelIds: [] }, declined(), INTERVIEWERS);
    expect(r).toEqual({ ok: true, value: { leadId: WEN, panelIds: [] } });
    expect(applyReassignment(declined(), { leadId: WEN, panelIds: [] })).toEqual({ leadId: WEN, panelIds: [], state: 'assigned', acceptances: [] });
    expect(newlySeated(declined(), { leadId: WEN, panelIds: [] })).toEqual([WEN]);
  });

  it('changing only the panel keeps the state and the acceptances of the seats that stay', () => {
    const accepted: Interview = { ...interviewsFixture.rows().find((i) => i.id === 'iv-n5z9f2cq')! };
    expect(accepted.state).toBe('accepted');
    const seats = { leadId: WEN, panelIds: [HUGO, THIRD] };
    expect(checkReassignment(seats, accepted, INTERVIEWERS).ok).toBe(true);
    const change = applyReassignment(accepted, seats);
    expect(change).toMatchObject({ state: 'accepted', panelIds: [HUGO, THIRD] });
    expect(change.acceptances.map((a) => a.userId).sort()).toEqual([HUGO, WEN].sort());
    expect(newlySeated(accepted, seats)).toEqual([THIRD]);
  });

  it('a new lead drops the old lead\'s acceptance; someone moved between seats is asked again', () => {
    const accepted: Interview = { ...interviewsFixture.rows().find((i) => i.id === 'iv-n5z9f2cq')! };
    const change = applyReassignment(accepted, { leadId: HUGO, panelIds: [WEN] });
    expect(change).toEqual({ leadId: HUGO, panelIds: [WEN], state: 'assigned', acceptances: [] });
    expect(newlySeated(accepted, { leadId: HUGO, panelIds: [WEN] })).toEqual([HUGO, WEN]);
  });

  it('nothing changes once the call has started or for a cancelled round, and a no-op is refused', () => {
    const live: Interview = { ...declined(), state: 'live' };
    expect(paths(checkReassignment({ leadId: WEN, panelIds: [] }, live, INTERVIEWERS))).toEqual(['state']);
    expect(paths(checkReassignment({ leadId: WEN, panelIds: [] }, { ...live, state: 'cancelled' }, INTERVIEWERS))).toEqual(['state']);
    const assigned = interviewsFixture.rows().find((i) => i.id === 'iv-h4m7c3vu')!;
    expect(paths(checkReassignment({ leadId: HUGO, panelIds: [] }, assigned, INTERVIEWERS))).toEqual(['leadId']);
    expect(paths(checkReassignment({ leadId: HUGO, panelIds: [HUGO] }, assigned, INTERVIEWERS))).toEqual(['panelIds.0']);
  });
});

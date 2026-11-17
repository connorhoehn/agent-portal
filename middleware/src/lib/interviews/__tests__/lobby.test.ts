// The interview's lobby names and its seat rule (lib/interviews/lobby.ts; docs/interviews-tenant-plan.md row I2.2).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { CALL_STATES, guestCallSession, guestOfContext, guestOfSession, guestSeatRule, interviewLobbyName, interviewOfLobby, staffSeatRule, type StaffSeatFacts } from '../lobby.js';
import { INTERVIEW_STATES, type Interview } from '../types.js';

const interview = (over: Partial<Interview> = {}) => ({ id: 'iv-1', state: 'ready' as Interview['state'], leadId: 'u-lead', panelIds: ['u-panel'], type: 'technical' as Interview['type'], ...over });
const staff = (over: Partial<StaffSeatFacts> = {}): StaffSeatFacts => ({ flagOn: true, tenant: 'interviews', sub: 'u-lead', mayView: true, interview: interview(), ...over });

describe('the lobby\'s name (C1)', () => {
  it('names one interview and reads it back; nothing else reads as a lobby', () => {
    expect(interviewLobbyName('iv-k1p5w8ra')).toBe('interviews:interview:iv-k1p5w8ra');
    expect(interviewOfLobby('interviews:interview:iv-k1p5w8ra')).toBe('iv-k1p5w8ra');
    for (const other of ['interviews:interview:', 'interviews:interview:a:b', 'presence:interviews:interview:iv-1', 'interviews:interviewx:iv-1',
      'orgiq:initiative:iv-1', `interviews:interview:${'x'.repeat(41)}`, 'interviews:interview:iv-1~breakout~r1']) {
      expect([other, interviewOfLobby(other)]).toEqual([other, null]);
    }
  });
});

describe('the staff seat', () => {
  it('is the lead and the panel of that interview', () => {
    expect(staffSeatRule(staff())).toBe(true);
    expect(staffSeatRule(staff({ sub: 'u-panel' }))).toBe(true);
  });

  it('row I2.7: the lead and each of two panel members; a member a reassignment removed holds nothing', () => {
    const two = interview({ panelIds: ['u-panel', 'u-panel-2'] });
    for (const sub of ['u-lead', 'u-panel', 'u-panel-2']) expect([sub, staffSeatRule(staff({ sub, interview: two }))]).toEqual([sub, true]);
    const after = interview({ panelIds: ['u-panel'] });
    expect(staffSeatRule(staff({ sub: 'u-panel-2', interview: after }))).toBe(false);
    expect(staffSeatRule(staff({ sub: 'u-panel', interview: after }))).toBe(true);
  });

  it.each([
    ['the recruiter or the hiring manager (no seat on the round)', { sub: 'u-recruiter' }],
    ['an interviewer of another round', { interview: interview({ leadId: 'u-other', panelIds: [] }) }],
    ['another tenant', { tenant: 'orgiq' }],
    ['a role without ViewInterviews', { mayView: false }],
    ['anyone while the flag is off', { flagOn: false }],
    ['an interview that does not exist', { interview: null }],
    ['an empty subject', { sub: '' }],
  ])('refuses %s', (_who, over) => {
    expect(staffSeatRule(staff(over as Partial<StaffSeatFacts>))).toBe(false);
  });

  it('holds only while the call can happen: accepted, ready, live', () => {
    expect([...CALL_STATES]).toEqual(['accepted', 'ready', 'live']);
    for (const state of INTERVIEW_STATES) {
      expect([state, staffSeatRule(staff({ interview: interview({ state }) }))]).toEqual([state, CALL_STATES.includes(state)]);
    }
  });

  it('the pad needs a technical round as well', () => {
    expect(staffSeatRule(staff({ pad: true }))).toBe(true);
    expect(staffSeatRule(staff({ pad: true, interview: interview({ type: 'behavioural' }) }))).toBe(false);
    expect(staffSeatRule(staff({ interview: interview({ type: 'behavioural' }) }))).toBe(true);
  });
});

describe('the guest seat', () => {
  const guest = (over: Partial<Parameters<typeof guestSeatRule>[0]> = {}) =>
    guestSeatRule({ flagOn: true, guestInterviewId: 'iv-1', interview: interview(), admission: 'admitted', ...over });

  it('is its own interview, once admitted', () => {
    expect(guest()).toBe(true);
  });

  it.each(['not-knocked', 'waiting', 'turned-away'] as const)('refuses a guest who is %s', (admission) => {
    expect(guest({ admission })).toBe(false);
  });

  it('refuses another interview, a dead invite, the flag off, a closed interview, and a behavioural pad', () => {
    expect(guest({ interview: interview({ id: 'iv-2' }) })).toBe(false);
    expect(guest({ guestInterviewId: null })).toBe(false);
    expect(guest({ flagOn: false })).toBe(false);
    for (const state of ['assigned', 'ended', 'scored', 'cancelled', 'declined'] as const) expect(guest({ interview: interview({ state }) })).toBe(false);
    expect(guest({ pad: true, interview: interview({ type: 'behavioural' }) })).toBe(false);
    expect(guest({ pad: true })).toBe(true);
  });
});

describe('a guest context, by its claims', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    userId: 'guest:inv-1', org: 'interviews', tenants: [], role: 'interview-guest', guest: { interviewId: 'iv-1', inviteId: 'inv-1', session: 'tag' }, ...over,
  });
  it('reads the three claims of a well-formed guest', () => {
    expect(guestOfContext(ctx())).toEqual({ interviewId: 'iv-1', inviteId: 'inv-1', session: 'tag' });
  });
  it.each([
    ['a staff role', { role: 'recruiter' }],
    ['a tenant claim', { tenants: ['interviews'] }],
    ['another org', { org: 'orgiq' }],
    ['a subject that is not its invite\'s', { userId: 'guest:inv-2' }],
    ['no guest claim', { guest: undefined }],
    ['a masquerade actor', { act: { sub: 'u-admin', epoch: 0 } }],
    ['a malformed interview id', { guest: { interviewId: 'a:b', inviteId: 'inv-1', session: 'tag' } }],
  ])('is not a guest with %s', (_what, over) => {
    expect(guestOfContext(ctx(over))).toBeNull();
  });
});

describe('a guest Session, as the call runtimes hold it', () => {
  const guest = { interviewId: 'iv-1', inviteId: 'inv-1', session: 'tag' };
  it('carries the guest\'s claims, its session tag among them, through a spread', () => {
    const session = guestCallSession(guest);
    expect(guestOfSession(session)).toEqual(guest);
    expect(guestOfSession({ ...session, grants: { interviews: ['interview-guest'] } })).toEqual(guest);
  });
  it('is no guest without its claims, with a subject that is not its invite\'s, or as a staff role', () => {
    const { guest: _drop, ...bare } = guestCallSession(guest);
    expect(guestOfSession(bare)).toBeNull();
    expect(guestOfSession({ ...guestCallSession(guest), sub: 'guest:inv-2' })).toBeNull();
    expect(guestOfSession({ ...guestCallSession(guest), role: 'interviewer' as never })).toBeNull();
    expect(guestOfSession({ ...guestCallSession(guest), guest: { ...guest, session: '' } } as never)).toBeNull();
  });
});

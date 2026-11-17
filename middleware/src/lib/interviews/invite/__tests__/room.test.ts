// The candidate's room (lib/interviews/invite/room.ts; row I2.4, the candidate's side; contract D1): when the
// guest may read its room, and what the read carries. The route itself is in routes/__tests__/interviews-invite.test.ts.
import { guestRoomState, guestRoomView } from '../room.js';
import { inviteCeiling } from '../rules.js';
import { hashInviteToken, newInviteToken } from '../token.js';
import type { Admission } from '../admission.js';
import type { Invite } from '../store.js';
import type { Interview, InterviewState, Opening } from '../../types.js';

const HOUR = 3_600_000;
const T0 = '2026-11-16T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms);

const interview = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-1', applicationId: 'app-1', roundId: 'rd-1', type: 'technical', leadId: 'u-lead', panelIds: ['u-panel'], scheduledAt: at(HOUR).toISOString(),
  minutes: 60, state: 'live', questionIds: ['q-1'], assignedBy: 'u-rec', assignedAt: T0, inviteTokenHash: null, callId: null, endedAt: null, acceptances: [], declines: [], revision: 1, ...over,
});
const invite = (over: Partial<Invite> = {}): Invite => ({
  id: 'inv-1', interviewId: 'iv-1', tokenHash: hashInviteToken(newInviteToken()), issuedBy: 'u-rec', issuedAt: T0, expiresAt: inviteCeiling(T0),
  revokedAt: null, revokedBy: null, firstOpenedAt: T0, lastOpenedAt: T0, openCount: 1, sessionHash: 'a'.repeat(64),
  admissionState: 'admitted', knockedAt: T0, admissionDecidedAt: T0, ...over,
});
const admitted: Admission = { state: 'admitted', knockedAt: T0, decidedAt: T0 };
const now = at(HOUR + 10 * 60_000);

describe('when the guest may read its room', () => {
  it('open while admitted and the call can happen', () => {
    for (const state of ['accepted', 'ready', 'live'] as InterviewState[]) expect([state, guestRoomState(invite(), interview({ state }), admitted, now)]).toEqual([state, 'open']);
  });
  it('ended once the interview is over after the guest was let in, until the link expires', () => {
    for (const state of ['ended', 'scored', 'reviewed'] as InterviewState[]) expect([state, guestRoomState(invite(), interview({ state }), admitted, now)]).toEqual([state, 'ended']);
    expect(guestRoomState(invite(), interview({ state: 'ended' }), admitted, at(HOUR + 25 * HOUR))).toBeNull();
  });
  it.each([
    ['not knocked', invite(), interview(), { ...admitted, state: 'not-knocked' } as Admission],
    ['waiting', invite(), interview(), { ...admitted, state: 'waiting' } as Admission],
    ['turned away', invite(), interview(), { ...admitted, state: 'turned-away' } as Admission],
    ['a revoked link', invite({ revokedAt: T0 }), interview(), admitted],
    ['a revoked link to an ended interview', invite({ revokedAt: T0 }), interview({ state: 'ended' }), admitted],
    ['an interview that was cancelled', invite(), interview({ state: 'cancelled' }), admitted],
    ['an interview that was declined', invite(), interview({ state: 'declined' }), admitted],
    ['an interview that ended before the guest was let in', invite(), interview({ state: 'ended' }), { ...admitted, state: 'waiting' } as Admission],
    ['another interview', invite({ interviewId: 'iv-2' }), interview(), admitted],
  ])('refuses %s', (_what, inv, iv, adm) => {
    expect(guestRoomState(inv, iv, adm, now)).toBeNull();
  });
  it('refuses a missing interview', () => {
    expect(guestRoomState(invite(), null, admitted, now)).toBeNull();
  });
});

describe('what the read carries', () => {
  it('the lobby, the guest\'s own call identity, the round, the time and the state; nothing of the panel or the questions', () => {
    const opening = { kit: { rounds: [{ id: 'rd-1', name: 'System design' }] } } as unknown as Pick<Opening, 'kit'>;
    const view = guestRoomView({ userId: 'guest:inv-1', displayName: 'Candidate' }, interview(), opening, 'open');
    expect(view).toEqual({
      interviewId: 'iv-1', lobbyName: 'interviews:interview:iv-1', self: { userId: 'guest:inv-1', displayName: 'Candidate' },
      round: { name: 'System design', type: 'technical', minutes: 60 }, scheduledAt: at(HOUR).toISOString(), startedAt: null, state: 'open',
    });
    expect(JSON.stringify(view)).not.toMatch(/u-lead|u-panel|q-1/);
    expect(guestRoomView({ userId: 'guest:inv-1', displayName: 'Candidate' }, interview({ type: 'behavioural' }), null, 'ended').round.name).toBe('Interview');
  });
});

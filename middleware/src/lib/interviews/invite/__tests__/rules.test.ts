// The invite's rules (lib/interviews/invite/rules.ts; docs/interviews-tenant-plan.md row I2.1): expiry, one
// interview only, revocation, and the token's shape and hash. Reuse and one-live-invite are store and route
// behaviour: store.test.ts and routes/__tests__/interviews-invite.test.ts hold them.
import {
  INVITE_DAYS_WITHOUT_TIME, INVITE_HOURS_AFTER_INTERVIEW, INVITE_MAX_DAYS, inviteCeiling, inviteDeadReason, inviteExpiresAt, inviteStatus, issuable,
} from '../rules.js';
import { hashInviteToken, newInviteToken, sameHash, wellFormedToken } from '../token.js';
import type { Invite } from '../store.js';
import type { Interview, InterviewState } from '../../types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = '2026-11-16T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms);

const interview = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-1', applicationId: 'app-1', roundId: 'rd-1', type: 'technical', leadId: 'u-lead', panelIds: [], scheduledAt: at(3 * DAY).toISOString(),
  minutes: 60, state: 'ready', questionIds: [], assignedBy: 'u-rec', assignedAt: T0, inviteTokenHash: null, callId: null, endedAt: null, acceptances: [], declines: [], revision: 1, ...over,
});
const invite = (over: Partial<Invite> = {}): Invite => ({
  id: 'inv-1', interviewId: 'iv-1', tokenHash: hashInviteToken(newInviteToken()), issuedBy: 'u-rec', issuedAt: T0, expiresAt: inviteCeiling(T0),
  revokedAt: null, revokedBy: null, firstOpenedAt: null, lastOpenedAt: null, openCount: 0, sessionHash: null,
  admissionState: 'not-knocked', knockedAt: null, admissionDecidedAt: null, ...over,
});

describe('expiry', () => {
  it('ends a fixed number of hours after the interview\'s time when it has one', () => {
    const iv = interview();
    expect(inviteExpiresAt(invite(), iv)).toBe(new Date(Date.parse(iv.scheduledAt!) + INVITE_HOURS_AFTER_INTERVIEW * HOUR).toISOString());
    expect(inviteDeadReason(invite(), iv, at(3 * DAY + INVITE_HOURS_AFTER_INTERVIEW * HOUR - 1))).toBeNull();
    expect(inviteDeadReason(invite(), iv, at(3 * DAY + INVITE_HOURS_AFTER_INTERVIEW * HOUR))).toBe('expired');
  });

  it('ends a fixed number of days after issue when the interview has no time', () => {
    const iv = interview({ scheduledAt: null });
    expect(inviteExpiresAt(invite(), iv)).toBe(at(INVITE_DAYS_WITHOUT_TIME * DAY).toISOString());
    expect(inviteDeadReason(invite(), iv, at(INVITE_DAYS_WITHOUT_TIME * DAY - 1))).toBeNull();
    expect(inviteDeadReason(invite(), iv, at(INVITE_DAYS_WITHOUT_TIME * DAY))).toBe('expired');
  });

  it('follows the interview\'s time as it is now, so moving the interview moves the expiry', () => {
    const moved = interview({ scheduledAt: at(10 * DAY).toISOString() });
    expect(inviteDeadReason(invite(), moved, at(5 * DAY))).toBeNull();
  });

  it('never outlives the ceiling stored at issue, however far out the interview moves', () => {
    const far = interview({ scheduledAt: at(90 * DAY).toISOString() });
    expect(inviteExpiresAt(invite(), far)).toBe(at(INVITE_MAX_DAYS * DAY).toISOString());
    expect(inviteDeadReason(invite(), far, at(INVITE_MAX_DAYS * DAY))).toBe('expired');
  });
});

describe('revocation and the interview\'s state', () => {
  it('a revoked invite is dead whatever else holds', () => {
    expect(inviteDeadReason(invite({ revokedAt: T0, revokedBy: 'u-rec' }), interview(), at(1))).toBe('revoked');
  });

  it.each<InterviewState>(['declined', 'cancelled', 'ended', 'scored', 'reviewed'])('a %s interview lets no one in', (state) => {
    expect(inviteDeadReason(invite(), interview({ state }), at(1))).toBe('closed');
  });

  it.each<InterviewState>(['assigned', 'accepted', 'ready', 'live'])('a %s interview still has a candidate to let in', (state) => {
    expect(inviteDeadReason(invite(), interview({ state }), at(1))).toBeNull();
  });
});

describe('one interview only', () => {
  it('an invite answers only for its own interview, and not at all when the interview is gone', () => {
    expect(inviteDeadReason(invite(), interview({ id: 'iv-2' }), at(1))).toBe('other-interview');
    expect(inviteDeadReason(invite(), null, at(1))).toBe('other-interview');
  });
});

describe('issuing', () => {
  it('refuses a closed interview and one whose time has passed so long ago a link would be born dead', () => {
    expect(issuable(interview({ state: 'cancelled' }), at(0))).toBe('closed');
    expect(issuable(interview({ scheduledAt: at(-2 * DAY).toISOString() }), at(0))).toBe('past');
    expect(issuable(interview({ scheduledAt: at(-2 * HOUR).toISOString() }), at(0))).toBe('ok');
    expect(issuable(interview({ scheduledAt: null }), at(0))).toBe('ok');
  });

  it('the status never carries the token or its hash', () => {
    const s = inviteStatus(invite({ firstOpenedAt: T0, lastOpenedAt: T0, openCount: 2 }), interview(), at(1));
    expect(s.state).toBe('live');
    expect(JSON.stringify(s)).not.toMatch(/[0-9a-f]{64}/);
    expect(Object.keys(s)).not.toContain('tokenHash');
    expect(inviteStatus(null, interview(), at(1)).state).toBe('none');
  });
});

describe('the token', () => {
  it('is 32 random bytes, base64url, and only its SHA-256 is compared', () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(wellFormedToken(a)).toBe(true);
    expect(wellFormedToken(`${a}x`)).toBe(false);
    expect(wellFormedToken(42)).toBe(false);
    expect(hashInviteToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sameHash(hashInviteToken(a), hashInviteToken(a))).toBe(true);
    expect(sameHash(hashInviteToken(a), hashInviteToken(b))).toBe(false);
    expect(sameHash(hashInviteToken(a), 'short')).toBe(false);
  });
});

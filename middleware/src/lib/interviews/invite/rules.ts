// When an invite is alive (docs/interviews-tenant-plan.md, row I2.1; decision 3). Pure: every function
// takes the rows and the time, so the four rules the row names (expiry, one interview only, reuse,
// revocation) are tested without a store or a clock.
//
//   One live invite per interview   issuing again revokes the one before (the store does it in one write).
//   Expiry                          a fixed number of hours after the interview's time when it has one,
//                                   otherwise a fixed number of days after issue; never later than a fixed
//                                   ceiling after issue, so a link to an interview moved far out still ends.
//                                   Read against the interview as it is now, so moving the time moves it.
//   Dead                            revoked, expired, or the interview declined, cancelled or over.
//   Reuse                           the link keeps working until it expires or is revoked: a candidate who
//                                   changes device must not be locked out, and there is no email to send
//                                   another. Every opening is recorded, and a new exchange ends the guest
//                                   session before it (guest.ts), so one invite never has two live guests.
//   One interview only              the guest principal names the invite's interview and nothing else
//                                   (guest.ts); the guest read answers for that interview alone.

import type { Interview, InterviewState } from '../types.js';
import type { Invite } from './store.js';

/** Hours after the interview's start the link keeps working (a late start, a second try after a dropped call). */
export const INVITE_HOURS_AFTER_INTERVIEW = 24;
/** Days a link to an interview with no time yet keeps working. */
export const INVITE_DAYS_WITHOUT_TIME = 14;
/** Days after issue no link outlives, whatever the interview's time. Stored as the invite's `expiresAt`. */
export const INVITE_MAX_DAYS = 30;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The states in which an interview still has a candidate to let in. */
export const OPEN_INTERVIEW_STATES: readonly InterviewState[] = ['assigned', 'accepted', 'ready', 'live'];

export function interviewOpen(interview: Pick<Interview, 'state'>): boolean {
  return OPEN_INTERVIEW_STATES.includes(interview.state);
}

/** The ceiling stored on the invite when it is issued. */
export function inviteCeiling(issuedAt: string): string {
  return new Date(Date.parse(issuedAt) + INVITE_MAX_DAYS * DAY).toISOString();
}

/** When the invite stops working, read against the interview as it is now. */
export function inviteExpiresAt(invite: Pick<Invite, 'issuedAt' | 'expiresAt'>, interview: Pick<Interview, 'scheduledAt'>): string {
  const byTime = interview.scheduledAt
    ? Date.parse(interview.scheduledAt) + INVITE_HOURS_AFTER_INTERVIEW * HOUR
    : Date.parse(invite.issuedAt) + INVITE_DAYS_WITHOUT_TIME * DAY;
  return new Date(Math.min(byTime, Date.parse(invite.expiresAt))).toISOString();
}

export type DeadReason = 'revoked' | 'expired' | 'closed' | 'other-interview';

/**
 * Why the invite no longer lets anyone in, or null while it does. `interview` is the invite's interview as
 * the store has it now (null: gone). The guest never learns which reason it was; the recruiter's status does.
 */
export function inviteDeadReason(invite: Invite, interview: Interview | null, now: Date): DeadReason | null {
  if (invite.revokedAt !== null) return 'revoked';
  if (!interview || interview.id !== invite.interviewId) return 'other-interview';
  if (!interviewOpen(interview)) return 'closed';
  if (now.getTime() >= Date.parse(inviteExpiresAt(invite, interview))) return 'expired';
  return null;
}

/** Whether an invite may be issued for this interview at `now`: open, and a link issued now would not already be dead. */
export function issuable(interview: Interview, now: Date): 'ok' | 'closed' | 'past' {
  if (!interviewOpen(interview)) return 'closed';
  const issuedAt = now.toISOString();
  const draft = { issuedAt, expiresAt: inviteCeiling(issuedAt) };
  return Date.parse(inviteExpiresAt(draft, interview)) > now.getTime() ? 'ok' : 'past';
}

/** What the recruiter's status route says about the interview's latest invite. Never the token or its hash. */
export interface InviteStatus {
  state: 'none' | 'live' | DeadReason;
  issuedAt: string | null;
  issuedBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
}

export function inviteStatus(invite: Invite | null, interview: Interview, now: Date): InviteStatus {
  if (!invite) {
    return { state: 'none', issuedAt: null, issuedBy: null, expiresAt: null, revokedAt: null, firstOpenedAt: null, lastOpenedAt: null, openCount: 0 };
  }
  return {
    state: inviteDeadReason(invite, interview, now) ?? 'live',
    issuedAt: invite.issuedAt,
    issuedBy: invite.issuedBy,
    expiresAt: inviteExpiresAt(invite, interview),
    revokedAt: invite.revokedAt,
    firstOpenedAt: invite.firstOpenedAt,
    lastOpenedAt: invite.lastOpenedAt,
    openCount: invite.openCount,
  };
}

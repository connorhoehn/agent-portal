// The candidate's room (docs/interviews-tenant-plan.md row I2.4, the candidate's side; contract D1 between the
// round-4 lanes): what `GET /api/interview-invite/room` answers, and when. Pure; the route reads the facts.
//
// A guest is refused everything. This opens one read: the call the guest may join, once the lead let it in.
//   open    the invite is live, the guest's admission is `admitted`, and the interview's call can happen
//           (accepted, ready, live: the same states as the seat in lib/interviews/lobby.ts);
//   ended   the interview is over (ended, scored, reviewed) and the guest had been admitted to it, while the link
//           has not expired and was not revoked: the page shows the ended page, not a dead link;
//   null    everything else (not admitted, turned away, revoked, expired, cancelled, declined): the guest router's
//           one not-found.
// The view carries the lobby, the guest's own call identity (the token's: `guest:<inviteId>`, "Candidate"), the
// round's name, type and length, and the set time. No panel names, no questions, nothing from the candidate's
// record.
import type { Interview, InterviewState, Opening } from '../types.js';
import type { Admission } from './admission.js';
import { inviteDeadReason, inviteExpiresAt } from './rules.js';
import type { Invite } from './store.js';

/** The interview states in which its call can happen (lib/interviews/lobby.ts CALL_STATES; not imported: lobby imports this folder). */
export const ROOM_OPEN_STATES: readonly InterviewState[] = ['accepted', 'ready', 'live'];
/** The interview states that mean its call is over for good. */
export const ROOM_OVER_STATES: readonly InterviewState[] = ['ended', 'scored', 'reviewed'];

export type GuestRoomState = 'open' | 'ended';

/** D1's rule. `admission` is the invite's (admission.ts admissionOf). */
export function guestRoomState(invite: Invite, interview: Interview | null, admission: Admission, now: Date): GuestRoomState | null {
  if (!interview || admission.state !== 'admitted') return null;
  const dead = inviteDeadReason(invite, interview, now);
  if (dead === null) return ROOM_OPEN_STATES.includes(interview.state) ? 'open' : null;
  if (dead !== 'closed' || !ROOM_OVER_STATES.includes(interview.state)) return null;
  return now.getTime() < Date.parse(inviteExpiresAt(invite, interview)) ? 'ended' : null;
}

/** D1's answer. */
export interface GuestRoomView {
  interviewId: string;
  lobbyName: string;
  self: { userId: string; displayName: string };
  round: { name: string; type: 'technical' | 'behavioural'; minutes: number };
  scheduledAt: string | null;
  /** The interview record keeps no start instant (only `endedAt`), so this is null; the page counts from the call's start. */
  startedAt: string | null;
  state: GuestRoomState;
}

/** `self` is the guest's call identity as its realtime token names it (realtime.ts; passed in, since guest.ts imports this file). */
export function guestRoomView(self: GuestRoomView['self'], interview: Interview, opening: Pick<Opening, 'kit'> | null, state: GuestRoomState): GuestRoomView {
  const round = opening?.kit.rounds.find((r) => r.id === interview.roundId);
  return {
    interviewId: interview.id,
    lobbyName: `interviews:interview:${interview.id}`,
    self,
    round: { name: round?.name ?? (interview.type === 'technical' ? 'Technical interview' : 'Interview'), type: interview.type, minutes: interview.minutes },
    scheduledAt: interview.scheduledAt,
    startedAt: null,
    state,
  };
}

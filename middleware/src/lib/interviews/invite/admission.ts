// The waiting room's server half (docs/interviews-tenant-plan.md, rows I2.2 and I2.3; "I0.7 answer", "The guest's seat").
//
// Knocking in realtime-modules is client-side and only for direct calls, so the waiting room lives here: the
// guest's seat in the interview's call, its call chat and its pad are refused until the lead admits them
// (lib/interviews/lobby.ts asks `guestAdmitted`). platform-api's existing question to this middleware
// (/api/realtime/lobby-access, /call-seat) then enforces it with no new protocol.
//
// The admission belongs to the invite's CURRENT guest session and is stored on the invite (schema
// `interview_invites.admission_state`, `knocked_at`, `admission_decided_at`):
//
//   not-knocked    a fresh session: every new exchange of the link starts here (the store's recordOpening).
//   waiting        the guest knocked. Allowed only when `knockPrecondition` says yes (CONSENT's consents, wired
//                  at combine; the default says yes), from not-knocked or turned-away.
//   admitted       the lead let them in. Only the lead decides (routes/interviews/admission.ts).
//   turned-away    the lead said no, from waiting or admitted. The guest may knock again.
//
// The admission dies with the invite: a revoked or expired invite has no guest at all (guest.ts), and a revoked
// row takes no admission write. Every write is a compare-and-set on the session and the state it was decided
// against, so a lead's click on a session the link has since replaced changes nothing.

import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../types.js';
import { inviteStore, type Invite } from './store.js';

export const ADMISSION_STATES = ['not-knocked', 'waiting', 'admitted', 'turned-away'] as const;
export type AdmissionState = typeof ADMISSION_STATES[number];

/** C2's shape: what the guest's waiting page and the lead's prompt read. */
export interface Admission {
  state: AdmissionState;
  knockedAt: string | null;
  decidedAt: string | null;
}

export const NOT_KNOCKED: Admission = { state: 'not-knocked', knockedAt: null, decidedAt: null };

/** The admission an invite holds for its current guest session (none yet: not knocked). */
export function admissionOf(invite: Pick<Invite, 'sessionHash' | 'admissionState' | 'knockedAt' | 'admissionDecidedAt'> | null): Admission {
  if (!invite || !invite.sessionHash) return { ...NOT_KNOCKED };
  return { state: invite.admissionState ?? 'not-knocked', knockedAt: invite.knockedAt ?? null, decidedAt: invite.admissionDecidedAt ?? null };
}

export type AdmissionEvent = { kind: 'knock' } | { kind: 'decide'; admit: boolean };

/**
 * The next admission, or null when the event is not allowed from `current`. Pure. Repeating what already
 * happened (a second knock while waiting, admitting someone already admitted) answers the same admission, so
 * a double click is not an error.
 */
export function nextAdmission(current: Admission, event: AdmissionEvent, now: Date): Admission | null {
  const at = now.toISOString();
  if (event.kind === 'knock') {
    if (current.state === 'waiting' || current.state === 'admitted') return current;
    return { state: 'waiting', knockedAt: at, decidedAt: null };
  }
  if (event.admit) {
    if (current.state === 'admitted') return current;
    return current.state === 'waiting' ? { state: 'admitted', knockedAt: current.knockedAt, decidedAt: at } : null;
  }
  if (current.state === 'turned-away') return current;
  return current.state === 'waiting' || current.state === 'admitted' ? { state: 'turned-away', knockedAt: current.knockedAt, decidedAt: at } : null;
}

// ── C8: what must be true before a guest may knock ───────────────────────────
type KnockPrecondition = (interviewId: string) => Promise<boolean>;
const ALWAYS: KnockPrecondition = async () => true;
let precondition: KnockPrecondition = ALWAYS;
/** The integrator gives this CONSENT's `consentsAnswered` at combine. Null puts the default (always yes) back. */
export function setKnockPrecondition(fn: KnockPrecondition | null): void { precondition = fn ?? ALWAYS; }
export async function knockPrecondition(interviewId: string): Promise<boolean> {
  try { return (await precondition(interviewId)) === true; } catch { return false; }
}

export type AdmissionWrite = { ok: true; admission: Admission } | { ok: false; reason: 'not-allowed' | 'stale' | 'no-guest' | 'precondition' };

/** Apply `event` to the invite's current session, against the row as it is now. */
export async function applyAdmission(inviteId: string, event: AdmissionEvent, now = new Date()): Promise<AdmissionWrite> {
  return runWithDbTenant(INTERVIEWS_TENANT, async () => {
    const store = inviteStore();
    const invite = await store.getInvite(inviteId);
    if (!invite || invite.revokedAt !== null || !invite.sessionHash) return { ok: false, reason: 'no-guest' };
    if (event.kind === 'knock' && !await knockPrecondition(invite.interviewId)) return { ok: false, reason: 'precondition' };
    const current = admissionOf(invite);
    const next = nextAdmission(current, event, now);
    if (!next) return { ok: false, reason: 'not-allowed' };
    if (next === current) return { ok: true, admission: current };
    const written = await store.setAdmission(invite.id, invite.sessionHash, current.state,
      { admissionState: next.state, knockedAt: next.knockedAt, admissionDecidedAt: next.decidedAt });
    return written ? { ok: true, admission: admissionOf(written) } : { ok: false, reason: 'stale' };
  });
}

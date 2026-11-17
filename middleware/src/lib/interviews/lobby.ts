// The interview's call lobby and who holds a seat in it (docs/interviews-tenant-plan.md, row I2.2; decisions 3, 20;
// "I0.7 answer", "The guest's seat"; contract C1 between the round-3 lanes).
//
//   The lobby     `interviews:interview:<interviewId>`, a `lobby: true` family of the interviews tenant
//                 (lib/tenant-channels.ts). It carries the call (the library's calls feature), the lobby's
//                 presence, and the gateway's `call-lobby:` and `meeting:` channels for it. The call's chat is
//                 the huddle chat every page lobby's call has (`orgiq:huddle:<callId>`, lib/call-chat.ts).
//   Who sits      ONE rule (`staffSeatRule` / `guestSeatRule`, pure, below), asked fresh on every subscribe,
//                 publish, delivery and join, and by both of platform-api's questions:
//                   staff: in the interviews tenant, holding ViewInterviews, the lead or on the panel of THIS
//                     interview (decision 20), while it is accepted, ready or live;
//                   the guest (the candidate): its invite live, its realtime token naming the invite's current
//                     session, the invite's interview being THIS one, the lead having admitted it
//                     (lib/interviews/invite/admission.ts), and the same three states.
//                 The recruiter, the hiring manager, interviewers of other rounds, every other tenant, an
//                 interview that is assigned (no one has accepted the seat), over, declined or cancelled, and
//                 everything while the tenant's flag is off, are refused.
//
// The states, chosen: `accepted` (the lead may open the room before preparing), `ready` (prepared), `live` (the
// call is running). `assigned` has no accepted lead yet; `ended` and later are the record, not the call.
//
// The guest is never loaded from the directory. A socket or bearer whose verified claims carry the guest claim
// (`role` the guest role, `tenants` empty, `guest.interviewId`, `guest.inviteId`, `guest.session`) is loaded
// from its INVITE (lib/interviews/invite/guest.ts loadGuestSession), and only while guest realtime is on
// (lib/interviews/invite/realtime.ts guestRealtimeEnabled). lib/gateway/authority.ts sends every decision about
// such a context here and nowhere else, so every other family, namespace and route stays refused without a
// line of its own gate changing.
import { isAllowed } from '../authz.js';
import type { Session } from '../session.js';
import { runWithDbTenant } from '../../providers/db-tenant.js';
import { interviewsEnabled } from './flag.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type Interview, type InterviewState } from './types.js';
import { admissionOf, type AdmissionState } from './invite/admission.js';
import { GUEST_ROLE, guestSessionTag, loadGuestSession } from './invite/guest.js';
import { guestRealtimeEnabled, guestSubject } from './invite/realtime.js';
import { interviewsNow } from './clock.js';

export const INTERVIEW_LOBBY_PREFIX = 'interviews:interview:';
/** The pad's id rule (lib/interviews/pad/channel.ts): one id names the lobby and the pad alike. */
const INTERVIEW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** C1: the interview's call lobby. */
export function interviewLobbyName(interviewId: string): string { return `${INTERVIEW_LOBBY_PREFIX}${interviewId}`; }

/** C1: the interview a lobby names, or null for anything else (a service-prefixed name, a malformed id). */
export function interviewOfLobby(name: string): string | null {
  if (typeof name !== 'string' || !name.startsWith(INTERVIEW_LOBBY_PREFIX)) return null;
  const id = name.slice(INTERVIEW_LOBBY_PREFIX.length);
  return INTERVIEW_ID.test(id) ? id : null;
}

/** The interview states in which its call may be joined. */
export const CALL_STATES: readonly InterviewState[] = ['accepted', 'ready', 'live'];

// ── The rule, pure ───────────────────────────────────────────────────────────

export interface StaffSeatFacts {
  flagOn: boolean;
  tenant: string;
  sub: string;
  /** The role holds ViewInterviews in the interviews tenant now. */
  mayView: boolean;
  interview: Pick<Interview, 'id' | 'state' | 'leadId' | 'panelIds' | 'type'> | null;
  /** The pad: the round must be technical as well. */
  pad?: boolean;
}

export function staffSeatRule(f: StaffSeatFacts): boolean {
  if (!f.flagOn || f.tenant !== INTERVIEWS_TENANT || !f.mayView || !f.interview) return false;
  if (!CALL_STATES.includes(f.interview.state) || (f.pad && f.interview.type !== 'technical')) return false;
  return !!f.sub && (f.interview.leadId === f.sub || f.interview.panelIds.includes(f.sub));
}

export interface GuestSeatFacts {
  flagOn: boolean;
  /** The interview the guest's invite names; null when the invite is dead or its session was replaced. */
  guestInterviewId: string | null;
  /** The interview asked about, as the store has it now. */
  interview: Pick<Interview, 'id' | 'state' | 'type'> | null;
  admission: AdmissionState;
  pad?: boolean;
}

export function guestSeatRule(f: GuestSeatFacts): boolean {
  if (!f.flagOn || !f.guestInterviewId || !f.interview || f.interview.id !== f.guestInterviewId) return false;
  if (!CALL_STATES.includes(f.interview.state) || (f.pad && f.interview.type !== 'technical')) return false;
  return f.admission === 'admitted';
}

// ── Staff, read now ──────────────────────────────────────────────────────────

const findInterview = async (interviewId: string): Promise<Interview | null> =>
  runWithDbTenant(INTERVIEWS_TENANT, () => interviewsStore().getInterview(interviewId));

/** Does this (already current) staff session hold a seat in `interviewId`'s call now? */
export async function staffHoldsInterviewSeat(session: Session, interviewId: string, opts: { pad?: boolean } = {}): Promise<boolean> {
  if (!interviewsEnabled() || session.tenant !== INTERVIEWS_TENANT || (session.role as string) === GUEST_ROLE) return false;
  try {
    const mayView = await isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, 'ViewInterviews');
    if (!mayView) return false;
    return staffSeatRule({ flagOn: interviewsEnabled(), tenant: session.tenant, sub: session.sub, mayView, interview: await findInterview(interviewId), pad: opts.pad });
  } catch { return false; }
}

// ── The guest, read from its invite ──────────────────────────────────────────

type Context = Record<string, unknown> | null | undefined;
export interface ContextGuest { inviteId: string; interviewId: string; session: string }

/** Does this context CLAIM to be a guest (any guest-shaped field)? Such a context is never asked of the directory. */
export function claimsGuest(ctx: Context): boolean {
  if (!ctx || typeof ctx !== 'object') return false;
  return ctx['role'] === GUEST_ROLE || ctx['guest'] !== undefined || (typeof ctx['userId'] === 'string' && ctx['userId'].startsWith('guest:'));
}

/** The guest a verified context stands for, by its claims alone (no I/O), or null when it is not a well-formed guest. */
export function guestOfContext(ctx: Context): ContextGuest | null {
  if (!ctx || ctx['role'] !== GUEST_ROLE || ctx['org'] !== INTERVIEWS_TENANT) return null;
  if (!Array.isArray(ctx['tenants']) || (ctx['tenants'] as unknown[]).length !== 0 || ctx['act'] !== undefined) return null;
  const g = ctx['guest'] as Record<string, unknown> | undefined;
  if (!g || typeof g !== 'object') return null;
  const { inviteId, interviewId, session } = g;
  if (typeof inviteId !== 'string' || typeof interviewId !== 'string' || typeof session !== 'string' || !inviteId || !session) return null;
  if (ctx['userId'] !== guestSubject(inviteId) || !INTERVIEW_ID.test(interviewId)) return null;
  return { inviteId, interviewId, session };
}

/** The guest's facts read now: its interview while the invite and its session are alive (null otherwise), and its admission. */
async function guestFacts(guest: ContextGuest, now: Date): Promise<{ interview: Interview; admission: AdmissionState } | null> {
  if (!interviewsEnabled() || !guestRealtimeEnabled()) return null;
  const loaded = await loadGuestSession(guest.inviteId, (invite) => !!invite.sessionHash && guestSessionTag(invite.sessionHash) === guest.session, '', now);
  if (!loaded || loaded.interview.id !== guest.interviewId) return null;
  return { interview: loaded.interview, admission: admissionOf(loaded.invite).state };
}

/** Is this guest context alive now (invite live, its session current), admitted or not? The socket's principal check. */
export async function guestContextCurrent(ctx: Context, now = interviewsNow()): Promise<boolean> {
  const guest = guestOfContext(ctx);
  try { return !!guest && !!await guestFacts(guest, now); } catch { return false; }
}

/**
 * Does this guest context hold a seat in `interviewId`'s call (or its pad) NOW? Read twice: the second read
 * follows every other read, so a revoke or a turn-away in between refuses.
 */
export async function guestHoldsInterviewSeat(ctx: Context, interviewId: string, opts: { pad?: boolean } = {}, now = interviewsNow()): Promise<boolean> {
  const guest = guestOfContext(ctx);
  if (!guest) return false;
  try {
    for (let read = 0; read < 2; read++) {
      const facts = await guestFacts(guest, now);
      if (!guestSeatRule({ flagOn: interviewsEnabled(), guestInterviewId: facts ? guest.interviewId : null, interview: facts?.interview ?? null,
        admission: facts?.admission ?? 'not-knocked', pad: opts.pad }) || interviewId !== guest.interviewId) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * A guest's Session as the call runtimes hold it (the huddle chat, the call's participants, the recipient check):
 * the guest's claims ride on it, its session tag among them, so every recheck asks the invite's CURRENT session.
 * Built only from a verified context (guestCallSession, lib/call-access.ts callContextSession); a spread of the
 * Session keeps it.
 */
export type GuestCallSession = Session & { guest: ContextGuest };

/** The guest a call runtime's Session stands for, or null: not a guest, or a guest Session without its claims. */
export function guestOfSession(session: Session): ContextGuest | null {
  if ((session.role as string) !== GUEST_ROLE || session.tenant !== INTERVIEWS_TENANT) return null;
  const g = (session as Partial<GuestCallSession>).guest;
  if (!g || typeof g !== 'object' || typeof g.inviteId !== 'string' || typeof g.interviewId !== 'string' || typeof g.session !== 'string') return null;
  if (!g.inviteId || !g.session || session.sub !== guestSubject(g.inviteId) || !INTERVIEW_ID.test(g.interviewId)) return null;
  return { inviteId: g.inviteId, interviewId: g.interviewId, session: g.session };
}

/**
 * The seat for a guest Session the call runtimes hold: the same facts as a socket's (guestFacts: the invite live,
 * its CURRENT session the one this Session's tag names, its interview this one, admitted). A Session without the
 * guest's claims (subject alone) holds nothing: a link opened again elsewhere, and admitted again there, must not
 * hand the older session's socket back its seat (round 3's session-tag gap).
 */
export async function guestSessionHoldsSeat(session: Session, interviewId: string, opts: { pad?: boolean } = {}, now = interviewsNow()): Promise<boolean> {
  const guest = guestOfSession(session);
  if (!guest || guest.interviewId !== interviewId) return false;
  try {
    // Read twice, as guestHoldsInterviewSeat does: a revoke or a turn-away between the reads refuses.
    for (let read = 0; read < 2; read++) {
      const facts = await guestFacts(guest, now);
      if (!guestSeatRule({ flagOn: interviewsEnabled(), guestInterviewId: facts ? guest.interviewId : null, interview: facts?.interview ?? null,
        admission: facts?.admission ?? 'not-knocked', pad: opts.pad })) return false;
    }
    return true;
  } catch { return false; }
}

/** The Session the call runtimes hold for a guest socket: the interviews tenant, the guest role, no grant but that role. */
export function guestCallSession(guest: ContextGuest): GuestCallSession {
  return {
    guest: { inviteId: guest.inviteId, interviewId: guest.interviewId, session: guest.session },
    sub: guestSubject(guest.inviteId), name: 'Candidate', tenant: INTERVIEWS_TENANT as Session['tenant'], role: GUEST_ROLE as Session['role'],
    epoch: 0, grants: { [INTERVIEWS_TENANT]: [GUEST_ROLE] }, iat: 0,
  };
}

/** Either seat, for a Session the caller already holds current: the guest by its live session's tag, staff by the rule. */
export async function sessionHoldsInterviewSeat(session: Session, interviewId: string, opts: { pad?: boolean } = {}): Promise<boolean> {
  return (session.role as string) === GUEST_ROLE ? guestSessionHoldsSeat(session, interviewId, opts) : staffHoldsInterviewSeat(session, interviewId, opts);
}

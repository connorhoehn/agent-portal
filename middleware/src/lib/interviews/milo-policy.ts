// Milo's policy for an interview call (docs/interviews-tenant-plan.md row I3.2; the seam is lib/meeting-assistant/policy.ts).
//
// Registered for the lobby family `interviews:interview` and nothing else, so every other call keeps the default (Work's)
// policy. An interview call's lobby is `interviews:interview:<interviewId>`; every rule below finds its interview from it.
//
//   inviteRefusal         only the interview's LEAD may invite Milo, turn its voice on or add time (decision 20), and only when
//                         the candidate's answers allow Milo in the call at all (row I2.5, consent/effects.ts
//                         `miloMayBeInvited`): Milo's live session is the listener that makes the transcript and it hears
//                         every microphone, so with the transcript declined, or nothing answered, the lead is refused with
//                         one plain sentence. With the transcript accepted and Milo declined the listener may run; the
//                         coach stays off (COACH's own check).
//   reads                 the record, the transcript and the minutes are the panel side's (decision 4): the lead, the panel,
//                         the recruiter and the opening's hiring manager, by the tenant's one scope rule (scope.ts). A seat in
//                         the call gives nothing by itself; a guest reads nothing; the admin gets no exception (as by default).
//   payer                 the opening, under the `interviews` source, within the cap per interview (spend.ts, I0.6).
//   sessionTools          none; mayUseTool: never (no tools and no data for anyone in an interview).
//   acknowledgement       the panel side acknowledges with the notice in the call; the candidate (a guest, `guest:<inviteId>`)
//                         acknowledged in the portal's consent (row I2.3), which `acknowledgedElsewhere` asks through
//                         `setInterviewConsentSource`. With no source set, nobody has, so nothing the candidate says is
//                         stored or heard.
//   rings, listsMeeting   the panel side only, never a guest (a guest has no bell and no Meetings list).
//   relaysLiveSpeech      never (decision 9: nothing the live model says reaches an interview, by voice or in chat).
//   answerFromHeldText    absent until row I3.8.
import { registerMeetingAssistantPolicy, type MeetingAssistantPolicy, type PolicyCall, type ReadAccess } from '../meeting-assistant/policy.js';
import { interviewsEnabled } from './flag.js';
import { visibleWorld } from './scope.js';
import { interviewsPayer } from './spend.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type Interview } from './types.js';
import { interviewRunsWith } from './consent/effects.js';

export const INTERVIEW_FAMILY = 'interviews:interview';

/** Refused to everyone but the interview's lead who tries to invite Milo, turn its voice on or add time. */
export const LEAD_ONLY = 'Only the lead interviewer of this interview can invite Milo, turn its voice on or add time.';

/** Refused to the lead when the candidate declined the transcript (row I2.5). */
export const MILO_OFF_NO_TRANSCRIPT = 'Milo is off for this interview: the candidate chose to go without a transcript.';

/** Refused to the lead while the candidate has not answered (nothing runs before consent). */
export const MILO_OFF_NOT_ANSWERED = 'Milo is off for this interview until the candidate has answered the questions about the transcript and Milo.';

const LOBBY = /^interviews:interview:([^:]+)$/;
const GUEST = /^guest:(.+)$/;

/** The interview a lobby names, or null when it names none. */
export const interviewOfLobby = (lobby: string | null | undefined): string | null => LOBBY.exec(lobby ?? '')?.[1] ?? null;

/** Is this user id a candidate's guest identity (lib/interviews/invite/realtime.ts `guestSubject`)? */
export const isGuestId = (userId: string): boolean => GUEST.test(userId);

// ── The candidate's acknowledgement from elsewhere (contract C8) ────────────────────────────────────────────────────────

/** What the candidate accepted in the portal's consent (row I2.3); null when they have not answered. */
export type InterviewConsentSource = (interviewId: string) => Promise<{ recording?: boolean; transcription: boolean; milo: boolean } | null>;

let consentSource: InterviewConsentSource | null = null;

/**
 * Where a candidate's consent is read from. Default null: nobody has acknowledged elsewhere, so nothing a guest says is stored
 * or heard. The integrator gives it CONSENT's `consentsFor` at combine; `null` puts the default back (tests).
 */
export function setInterviewConsentSource(fn: InterviewConsentSource | null): void { consentSource = fn; }

/** The invite a guest id was minted from belongs to this interview (a guest's seat is checked by the gateway; this is the second look). */
async function guestOfInterview(userId: string, interviewId: string): Promise<boolean> {
  const inviteId = GUEST.exec(userId)?.[1];
  if (!inviteId) return false;
  const { inviteStore } = await import('./invite/store.js');
  const invite = await inviteStore().getInvite(inviteId).catch(() => null);
  return invite?.interviewId === interviewId;
}

// ── The interview behind a call ─────────────────────────────────────────────────────────────────────────────────────────

async function interviewById(interviewId: string): Promise<Interview | null> {
  return (await interviewsStore().listInterviews()).find((i) => i.id === interviewId) ?? null;
}

/** Is this person on the panel side of the interview (decision 4), by the tenant's scope rule? Never the admin, never a guest. */
export async function onPanelSide(person: { userId: string; tenant: string; role?: string }, interviewId: string): Promise<boolean> {
  if (person.tenant !== INTERVIEWS_TENANT || !person.role || person.role === 'admin' || isGuestId(person.userId)) return false;
  const world = visibleWorld(await loadWorld(interviewsStore()), { id: person.userId, role: person.role });
  return world.interviews.some((i) => i.id === interviewId);
}

/**
 * The lead's refusal from the candidate's answers (row I2.5), or null when Milo may be invited. No source, a failing source and
 * no answers all read as "nothing answered": nothing runs before consent.
 */
export async function miloRefusalForConsent(interviewId: string): Promise<string | null> {
  const source = consentSource;
  const answer = source ? await source(interviewId).catch(() => null) : null;
  const runs = interviewRunsWith(answer && { recording: answer.recording === true, transcription: answer.transcription, milo: answer.milo });
  if (runs.miloMayBeInvited) return null;
  return answer ? MILO_OFF_NO_TRANSCRIPT : MILO_OFF_NOT_ANSWERED;
}

const NONE: ReadAccess = Object.freeze({ record: false, transcript: false, minutes: false });

export const INTERVIEWS_MILO_POLICY: MeetingAssistantPolicy = Object.freeze<MeetingAssistantPolicy>({
  id: 'interviews',
  inviteRefusal: async (person, call: PolicyCall) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId || person.tenant !== INTERVIEWS_TENANT || isGuestId(person.userId)) return LEAD_ONLY;
    const interview = await interviewById(interviewId).catch(() => null);
    if (!interview || interview.leadId !== person.userId) return LEAD_ONLY;
    return miloRefusalForConsent(interview.id);
  },
  reads: async (viewer, record) => {
    const interviewId = interviewOfLobby(record.lobby);
    if (!interviewId || record.tenant !== INTERVIEWS_TENANT) return NONE;
    const panel = await onPanelSide(viewer, interviewId).catch(() => false);
    return panel ? { record: true, transcript: true, minutes: true } : NONE;
  },
  payer: (_call, period) => interviewsPayer(period),
  sessionTools: () => ({ tools: [], backendInstructions: '' }),
  mayUseTool: () => false,
  acknowledgement: (_call, userId) => (isGuestId(userId) ? 'elsewhere' : 'in-call-notice'),
  acknowledgedElsewhere: async (call, userIds) => {
    const interviewId = interviewOfLobby(call.lobby);
    const source = consentSource;
    if (!interviewId || !source) return [];
    const guests = userIds.filter(isGuestId);
    if (!guests.length) return [];
    const answer = await source(interviewId).catch(() => null);
    if (!answer?.transcription || !answer.milo) return [];
    const mine = await Promise.all(guests.map(async (u) => ((await guestOfInterview(u, interviewId)) ? u : null)));
    return mine.filter((u): u is string => u !== null);
  },
  rings: (_call, userId) => !isGuestId(userId),
  listsMeeting: (_minutes, userId) => !isGuestId(userId),
  relaysLiveSpeech: () => false,
});

let unregister: (() => void) | null = null;

/** Register the interviews policy once, when the tenant's flag is on (idempotent). Returns whether it is registered now. */
export function registerInterviewsMiloPolicy(env: NodeJS.ProcessEnv = process.env): boolean {
  if (unregister) return true;
  if (!interviewsEnabled(env)) return false;
  unregister = registerMeetingAssistantPolicy(INTERVIEW_FAMILY, INTERVIEWS_MILO_POLICY);
  return true;
}

/** Tests: take the registration back. */
export function unregisterInterviewsMiloPolicy(): void { unregister?.(); unregister = null; }

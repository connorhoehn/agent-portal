// Milo's policy for an interview call (docs/interviews-tenant-plan.md row I3.2; the seam is lib/meeting-assistant/policy.ts).
//
// Registered for the lobby family `interviews:interview` and nothing else, so every other call keeps the default (Work's)
// policy. An interview call's lobby is `interviews:interview:<interviewId>`; every rule below finds its interview from it.
//
//   inviteRefusal         only the interview's LEAD may invite Milo, turn its voice on or add time (decision 20), and only when
//                         the candidate's answers allow Milo in the call at all (row I2.5, consent/effects.ts
//                         `miloMayBeInvited`): Milo's live session is the listener that makes the transcript and it hears
//                         every microphone, so with the transcript declined, or nothing answered, the lead is refused with
//                         one plain sentence. With the transcript accepted and Milo declined the listener runs and
//                         transcribes the candidate; nothing of Milo's uses their lines (`modelReadsSpeaker`, COACH's check).
//   reads                 the record, the transcript and the minutes are the panel side's (decision 4): the lead, the panel,
//                         the recruiter and the opening's hiring manager, by the tenant's one scope rule (scope.ts). A seat in
//                         the call gives nothing by itself; a guest reads nothing; the admin gets no exception (as by default).
//   payer                 the opening, under the `interviews` source, within the cap per interview (spend.ts, I0.6).
//   sessionTools          Milo's interview tools (milo-tools/, voice/catalogue.ts INTERVIEW_TOOLS) for a LIVE interview: the
//                         spoken ones (time left, repeat the question, introduce) in every round, the pad tools (test cases,
//                         imports, a helper) in a coding round; the background agent is told the round's coding questions as
//                         the thing not to solve, and the pad as it was when the session started. No data tools, ever.
//   mayUseTool / runTool  only those tools, for the interview's own people (lead, panel, candidate), run on the server
//                         (milo-tools/index.ts `runMiloTool`: who may ask, the checks, the pad write as Milo, the line logged);
//                         the orchestrator posts and says the line. Pad tools' arguments may be up to 12 KB.
//   acknowledgement       the panel side acknowledges with the notice in the call; the candidate (a guest, `guest:<inviteId>`)
//                         acknowledged in the portal's consent (row I2.3), which `acknowledgedElsewhere` asks through
//                         `setInterviewConsentSource`: the transcript accepted is enough. With no source set, nobody has,
//                         so nothing the candidate says is stored or heard.
//   modelReadsSpeaker     with Milo declined (the transcript accepted), the candidate is transcribed but Milo's models (the
//                         live session's context, the minutes, the decision checks) read none of their lines; the coach,
//                         the private answers, the recap and the notes already refuse or read the panel's lines only.
//   rings, listsMeeting   the panel side only, never a guest (a guest has no bell and no Meetings list).
//   relaysLiveSpeech      never (decision 9: nothing the live model says reaches an interview, by voice or in chat).
//   answerFromHeldText    row I3.8 (decision 10), now trigger (a) of Milo's tools: an exact phrase for a tool that takes no
//                         arguments ("how much time is left", "repeat the question", "Milo, introduce yourself", the lead's
//                         "Milo's here as our AI support") runs it at once through the same path as a call, no model. The
//                         line is logged there; the orchestrator posts it with the approved mark and says it as approved
//                         words; `heldTextSaid` marks the log row spoken. An empty answer: handled, nothing to say (a repeat).
//                         A guest of no live interview: the fixed sentence. Anything else: null, for the live model's call.
//   heldFallback          no call in time: the fixed sentence of what THIS asker may ask (milo-tools `fallbackLine`); the
//                         candidate without pad help gets MILO_CAN_DO as before; a panel member nothing.
//   heldAcknowledgement   "On it." while a slow pad tool's call is on its way (test cases, a helper; not an import).
//   holdHeldSpeech        the speech's money (decision 18): a held answer said aloud first holds a little under the interview's
//                         cap (speak/index.ts `holdSpeechMoney`); refused, the answer stays in the chat and nothing is said.
//   listeningLimitMinutes the round's minutes plus 15, the first ceiling and the most; no extension past it (60 + 15 when unreadable).
//   keepsOwnRetention     yes: the interviews retention removes an interview call's words (decision 17), not Milo's 30-day sweep.
//   minutesWording        "writes notes for the interview panel only": the candidate is in the call and never reads them (E4 #33).
import { randomBytes } from 'node:crypto';
import { registerMeetingAssistantPolicy, type MeetingAssistantPolicy, type PolicyCall, type ReadAccess } from '../meeting-assistant/policy.js';
import { interviewsEnabled } from './flag.js';
import { visibleWorld } from './scope.js';
import { interviewsPayer } from './spend.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type Interview } from './types.js';
import { interviewRunsWith } from './consent/effects.js';
import { MILO_CAN_DO } from './speak/index.js';
import { GUEST_DISPLAY_NAME } from './invite/realtime.js';
import { interviewsNowMs } from './clock.js';
import { addScriptRules } from '../meeting-assistant/scripted-session.js';
import { INTERVIEW_SCRIPT_RULES } from '../../mock/interviews-testcases.js';

export const INTERVIEW_FAMILY = 'interviews:interview';

/** The largest arguments a pad tool's call may carry (a dozen cases or a 60-line helper); every other tool keeps 4 KB. */
export const PAD_TOOL_ARGS_BYTES = 12_288;

/** Refused to everyone but the interview's lead who tries to invite Milo, turn its voice on or add time. */
export const LEAD_ONLY = 'Only the lead interviewer of this interview can invite Milo, turn its voice on or add time.';

/** Refused to the lead when the candidate declined the transcript (row I2.5). */
export const MILO_OFF_NO_TRANSCRIPT = 'Milo is off for this interview: the candidate chose to go without a transcript.';

/** Refused to the lead while the candidate has not answered (nothing runs before consent). */
export const MILO_OFF_NOT_ANSWERED = 'Milo is off for this interview until the candidate has answered the questions about the transcript and Milo.';

/** Milo listens for the round's minutes plus this many, and cannot be extended past that (round 6 decision). */
export const LISTEN_PAST_ROUND_MINUTES = 15;

/** The round's length taken when the interview or its round cannot be read: the most restrictive (60 + 15 minutes). */
export const UNREADABLE_ROUND_MINUTES = 60;

/** Refused when more time is asked for in an interview call. */
export const CANNOT_LISTEN_PAST_ROUND = "Milo can't listen past the end of this round.";

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
 * The stored answers, read straight from the consents store: what the lead's invite asks when no source is set. (The module's
 * own wiring, lib/interviews/consent/index.ts, sets `consentsFor` as the source; until something imports it, this keeps the
 * invite on the real answers rather than refusing every interview.) Milo needs the transcript, held here too.
 */
async function storedAnswers(interviewId: string): Promise<{ recording: boolean; transcription: boolean; milo: boolean } | null> {
  const { consentStore } = await import('./consent/store.js');
  const { runWithDbTenant } = await import('../../providers/db-tenant.js');
  const record = await runWithDbTenant(INTERVIEWS_TENANT, () => consentStore().getConsent(interviewId));
  return record ? { recording: record.recording, transcription: record.transcription, milo: record.transcription && record.milo } : null;
}

/**
 * The lead's refusal from the candidate's answers (row I2.5), or null when Milo may be invited. A failing read and no answers
 * both read as "nothing answered": nothing runs before consent.
 */
export async function miloRefusalForConsent(interviewId: string): Promise<string | null> {
  const source = consentSource ?? storedAnswers;
  const answer = await source(interviewId).catch(() => null);
  const runs = interviewRunsWith(answer && { recording: answer.recording === true, transcription: answer.transcription, milo: answer.milo });
  if (runs.miloMayBeInvited) return null;
  return answer ? MILO_OFF_NO_TRANSCRIPT : MILO_OFF_NOT_ANSWERED;
}

/** Did the candidate accept the transcript (the listener may hear them)? No answer and a failing read are no. */
export async function candidateTranscribed(interviewId: string): Promise<boolean> {
  const source = consentSource ?? storedAnswers;
  const answer = await source(interviewId).catch(() => null);
  return answer?.transcription === true;
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
  sessionTools: async (call) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId || call.tenant !== INTERVIEWS_TENANT) return { tools: [], backendInstructions: '' };
    const { sessionToolsFor } = await import('./milo-tools/index.js');
    return sessionToolsFor(interviewId).catch(() => ({ tools: [], backendInstructions: '' }));
  },
  mayUseTool: async (call, asker, tool) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId || call.tenant !== INTERVIEWS_TENANT) return false;
    const { mayAsk } = await import('./milo-tools/index.js');
    return mayAsk(interviewId, asker.userId, tool).catch(() => false);
  },
  runTool: async (call, request) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId) return null;
    const { runMiloTool } = await import('./milo-tools/index.js');
    return runMiloTool(interviewId, request.askedBy, request.name, request.args);
  },
  maxToolArgsBytes: (_call, tool) => (tool.startsWith('pad_') ? PAD_TOOL_ARGS_BYTES : 4096),
  acknowledgement: (_call, userId) => (isGuestId(userId) ? 'elsewhere' : 'in-call-notice'),
  acknowledgedElsewhere: async (call, userIds) => {
    const interviewId = interviewOfLobby(call.lobby);
    const source = consentSource;
    if (!interviewId || !source) return [];
    const guests = userIds.filter(isGuestId);
    if (!guests.length) return [];
    const answer = await source(interviewId).catch(() => null);
    // The transcript accepted is enough to be transcribed (decision 5); Milo declined is held by `modelReadsSpeaker` below.
    if (!answer?.transcription) return [];
    const mine = await Promise.all(guests.map(async (u) => ((await guestOfInterview(u, interviewId)) ? u : null)));
    return mine.filter((u): u is string => u !== null);
  },
  // Milo declined (or unreadable answers): Milo's models read none of the candidate's lines, and no line without one speaker.
  modelReadsSpeaker: async (call) => {
    const interviewId = interviewOfLobby(call.lobby);
    const source = consentSource ?? storedAnswers;
    const answer = interviewId ? await source(interviewId).catch(() => null) : null;
    if (answer?.transcription && answer.milo) return () => true;
    return (userId) => userId !== null && !isGuestId(userId);
  },
  // An interview has no Meetings page: its notes are read on the round's record page, in the tenant's own paths.
  meetingPath: (call) => {
    const interviewId = interviewOfLobby(call.lobby);
    return interviewId ? `/interviews/rounds/${encodeURIComponent(interviewId)}/record` : '/interviews/my-interviews';
  },
  rings: (_call, userId) => !isGuestId(userId),
  listsMeeting: (_minutes, userId) => !isGuestId(userId),
  relaysLiveSpeech: () => false,
  answerFromHeldText: async (call, request) => {
    const interviewId = interviewOfLobby(call.lobby);
    const interview = interviewId ? await interviewById(interviewId).catch(() => null) : null;
    // A guest's request never reaches a model without a live interview of its own behind the call: the fixed sentence (not logged).
    if (isGuestId(request.askedBy) && (!interview || interview.state !== 'live' || !(await guestOfInterview(request.askedBy, interview.id).catch(() => false)))) return MILO_CAN_DO;
    if (!interview || interview.state !== 'live') return null;
    const { runMiloTool, toolOfPhrase } = await import('./milo-tools/index.js');
    const tool = await toolOfPhrase(request.text);
    // Only the lead's words introduce Milo; anyone else saying them is left to the model (which may call `introduce`, refused).
    if (!tool || (tool === 'introduce' && request.askedBy !== interview.leadId)) return null;
    return (await runMiloTool(interview.id, request.askedBy, tool, {}).catch(() => null)) ?? '';
  },
  heldFallback: async (call, request) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId) return null;
    const { fallbackLine } = await import('./milo-tools/index.js');
    return fallbackLine(interviewId, request.askedBy, MILO_CAN_DO).catch(() => null);
  },
  heldFallbackWait: { quietMs: 4_000, delegatedMs: 15_000 },
  heldAcknowledgement: async (call, request) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId) return null;
    const { acknowledgementLine } = await import('./milo-tools/index.js');
    return acknowledgementLine(interviewId, request.askedBy, request.text).catch(() => null);
  },
  // The same fixed sentence for a request heard again (looping audio) is posted once per asker until Milo answers them something else (orchestrator.ts).
  heldRefusal: MILO_CAN_DO,
  // The candidate is not in the directory: Milo's chat names them by the interview's own record (seated as "Candidate" otherwise).
  displayName: async (call, userId) => {
    if (!isGuestId(userId)) return null;
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId || !(await guestOfInterview(userId, interviewId).catch(() => false))) return GUEST_DISPLAY_NAME;
    const { candidateName } = await import('./record/transcript.js');
    return (await candidateName(interviewId).catch(() => null)) ?? GUEST_DISPLAY_NAME;
  },
  // The speech's money (speak/index.ts): a held answer said aloud holds SPEECH_HOLD_USD under the interview's cap; refused, chat only.
  holdHeldSpeech: async (call) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId) return null;
    const { holdSpeechMoney } = await import('./speak/index.js');
    const hold = await holdSpeechMoney(interviewId, `held-${randomBytes(6).toString('hex')}`);
    return hold.ok ? { release: hold.release } : null;
  },
  heldTextSaid: async (call, said) => {
    const interviewId = interviewOfLobby(call.lobby);
    if (!interviewId) return;
    const { noteHeldSaid } = await import('./speak/index.js');
    await noteHeldSaid(interviewId, said.text, said.askedBy, said);
  },
  // Decision 17: an interview's transcript and minutes are media, kept 90 days by default or until a deletion request, and removed
  // by the interviews retention (retention/erasers.ts `transcript-and-minutes`), never by the meeting assistant's 30-day sweep.
  keepsOwnRetention: true,
  // E4 #33: the candidate is in the call and never reads Milo's notes; the notices say whose they are.
  minutesWording: { writes: 'writes notes for the interview panel only', adds: 'adds what it hears to the notes for the interview panel only' },
  listeningLimitMinutes: async (call) => {
    const interviewId = interviewOfLobby(call.lobby);
    const interview = interviewId ? await interviewById(interviewId).catch(() => null) : null;
    const minutes = interview?.minutes;
    return (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : UNREADABLE_ROUND_MINUTES) + LISTEN_PAST_ROUND_MINUTES;
  },
});

let unregister: (() => void) | null = null;

/** Register the interviews policy once, when the tenant's flag is on (idempotent). Returns whether it is registered now. */
export function registerInterviewsMiloPolicy(env: NodeJS.ProcessEnv = process.env): boolean {
  if (unregister) return true;
  if (!interviewsEnabled(env)) return false;
  const policy = registerMeetingAssistantPolicy(INTERVIEW_FAMILY, INTERVIEWS_MILO_POLICY);
  // The scripted session's stand-in for the tools' background agent (only a session offered an interview's tools follows them).
  const rules = addScriptRules(INTERVIEW_SCRIPT_RULES);
  unregister = () => { policy(); rules(); };
  return true;
}

/** Tests: take the registration back. */
export function unregisterInterviewsMiloPolicy(): void { unregister?.(); unregister = null; }

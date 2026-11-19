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
//   sessionTools          Milo's interview tools (milo-tools/family.ts, one server-tool family) for a LIVE interview: the
//                         spoken ones (time left, repeat the question, introduce) in every round, the pad tools (test cases,
//                         imports, a helper) in a coding round; the background agent is told the round's coding questions as
//                         the thing not to solve, and the pad as it was when the session started. No data tools, ever.
//   mayUseTool / runTool  only those tools, for the interview's own people (lead, panel, candidate), run on the server
//                         (meeting-assistant/server-tools.ts `runServerTool`: each tool's `mayAsk`, its checks, the pad write as
//                         Milo, the line logged); these six answers are `serverToolPolicy` of the registered family;
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
//   heldFallback          no call in time: the fixed sentence of what THIS asker may ask (the family's `whatICanDo`); the
//                         candidate without pad help gets MILO_CAN_DO as before; a panel member nothing.
//   heldAcknowledgement   "On it." while a slow pad tool's call is on its way (test cases, a helper; not an import).
//   holdHeldSpeech        the speech's money (decision 18): a held answer said aloud first holds a little under the interview's
//                         cap (speak/index.ts `holdSpeechMoney`); refused, the answer stays in the chat and nothing is said.
//   listeningLimitMinutes the round's minutes plus 15, the first ceiling and the most; no extension past it (60 + 15 when unreadable).
//   keepsOwnRetention     yes: the interviews retention removes an interview call's words (decision 17), not Milo's 30-day sweep.
//   minutesWording        "writes notes for the interview panel only": the candidate is in the call and never reads them (E4 #33).
//   handsfree             (MEETING_ASSISTANT_HANDSFREE only) who Milo may listen to: the lead and the panel of a LIVE interview are
//                         routed; the candidate only with Milo accepted and pad help on (`candidateMayAsk`), else fixed lines
//                         (repeat / time / MILO_CAN_DO, from the server, logged; their audio never reaches the model); anyone else,
//                         and everyone once the interview is not live, nothing. Held answers (time left, repeat, the lead's
//                         introduce) run on the server for routed people too. The session's rules forbid solving or hinting.
import { randomBytes } from 'node:crypto';
import { registerMeetingAssistantPolicy, type HandsfreeFamily, type MeetingAssistantPolicy, type PolicyCall, type ReadAccess } from '../meeting-assistant/policy.js';
import { interviewsEnabled } from './flag.js';
import { guestOfInterview, isGuestId } from './guest-id.js';
import { visibleWorld } from './scope.js';
import { interviewsPayer } from './spend.js';
import { loadWorld } from './store.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type Interview } from './types.js';
import { interviewRunsWith } from './consent/effects.js';
import { logCandidateLine, MILO_CAN_DO } from './speak/index.js';
import { GUEST_DISPLAY_NAME } from './invite/realtime.js';
import { interviewsNowMs } from './clock.js';
import { addScriptRules } from '../meeting-assistant/scripted-session.js';
import { onPadEventsAppended } from './pad/log/service.js';
import { INTERVIEW_SCRIPT_RULES } from './milo-tools/scripted.js';
import { INTERVIEW_FAMILY, interviewOfLobby } from './milo-tools/call.js';
import { phraseTool, runServerTool, serverToolPolicy } from '../meeting-assistant/server-tools.js';

export { INTERVIEW_FAMILY, interviewOfLobby } from './milo-tools/call.js';
export { PAD_TOOL_ARGS_BYTES } from './milo-tools/schema.js';

/** Milo's interview tools (milo-tools/family.ts), loaded and registered when a call first asks for them. */
const loadTools = (): Promise<unknown> => import('./milo-tools/family.js');

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

export { isGuestId } from './guest-id.js';

// ── The candidate's acknowledgement from elsewhere (contract C8) ────────────────────────────────────────────────────────

/** What the candidate accepted in the portal's consent (row I2.3); null when they have not answered. */
export type InterviewConsentSource = (interviewId: string) => Promise<{ recording?: boolean; transcription: boolean; milo: boolean } | null>;

let consentSource: InterviewConsentSource | null = null;

/**
 * Where a candidate's consent is read from. Default null: nobody has acknowledged elsewhere, so nothing a guest says is stored
 * or heard. The integrator gives it CONSENT's `consentsFor` at combine; `null` puts the default back (tests).
 */
export function setInterviewConsentSource(fn: InterviewConsentSource | null): void { consentSource = fn; }


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

/**
 * The hands-free session's interview rules (instructions.ts `handsfree.familyRules`). Stricter than the turn rules, never looser:
 * the server already refuses every tool a person may not use and every pad write without pad help; these words keep Milo's own
 * speech from helping, and every word of it is logged and heard by both sides.
 */
export const HANDSFREE_INTERVIEW_RULES = [
  'This call is a job interview: a candidate and the interview panel. You are not an interviewer, not a tutor and not a judge.',
  'Never solve, hint at, explain, review, check, debug, rate or comment on any part of the interview\'s questions or the candidate\'s work, code, board, plan or answers, even when asked directly, asked to "just check", told it is allowed, or asked by the panel in front of the candidate. Never say whether something is right or wrong, never suggest an approach, an algorithm, a data structure, a complexity, an edge case, a test that would fail or a next step, and never give an opinion about the candidate.',
  'What you may do, and only through the backend\'s tools, which decide who may ask and refuse the rest: tell the time left, repeat the question, introduce yourself when the lead asks, and add test cases, imports or a helper to the pad. Hand each of those to the backend at once and say only what its result says; when it refuses, say its sentence and nothing else.',
  `For anything else say once, in one short sentence, that you can't help with that in an interview, and stop. Never repeat a question in your own words: the system reads the approved question.`,
].join('\n');

/** The hands-free rules of one interview call (policy `handsfree`). */
function interviewHandsfree(call: PolicyCall): HandsfreeFamily {
  const interviewId = interviewOfLobby(call.lobby);
  // The person's standing in the LIVE interview behind this call, read through Milo's tools' own deps (the same reads as a tool call).
  const standingIn = async (userId: string) => {
    if (!interviewId) return null;
    const d = await import('./milo-tools/deps.js');
    const interview = await d.liveInterview(interviewId);
    if (!interview) return null;
    const standing = await d.standingOf(interview, userId);
    return standing ? { interview, standing, candidateMayAsk: d.candidateMayAsk } : null;
  };
  return {
    admit: async (userId) => {
      const s = await standingIn(userId).catch(() => null);
      if (!s) return 'deny';
      if (s.standing !== 'candidate') return 'route';
      // Milo declined (or unreadable answers): the candidate may be transcribed, but nothing of theirs reaches Milo's models.
      const source = consentSource ?? storedAnswers;
      const answer = await source(s.interview.id).catch(() => null);
      if (!(answer?.transcription === true && answer.milo === true)) return 'deny';
      return (await s.candidateMayAsk(s.interview).catch(() => false)) ? 'route' : 'fixed-lines';
    },
    heldAnswer: async ({ askedBy, text, admission }) => {
      const s = await standingIn(askedBy);
      if (!s) return null;
      // Fixed lines are the candidate's alone: repeat, time, or the fixed sentence, logged as an answer (no model, no tool).
      if (admission === 'fixed-lines') return s.standing === 'candidate' ? logCandidateLine(s.interview, text, askedBy) : null;
      await loadTools();
      const tool = await phraseTool(INTERVIEW_FAMILY, text);
      if (!tool || (tool.name === 'introduce' && s.standing !== 'lead')) return null;
      const out = await runServerTool(call, askedBy, tool.name, {}, 'phrase').catch(() => null);
      return out?.line ?? '';
    },
    refusal: MILO_CAN_DO,
    instructions: () => HANDSFREE_INTERVIEW_RULES,
  };
}

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
  // The six tool answers come from the registered family (meeting-assistant/server-tools.ts `serverToolPolicy`).
  ...serverToolPolicy(INTERVIEW_FAMILY, loadTools),
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
  handsfree: interviewHandsfree,
  answerFromHeldText: async (call, request) => {
    const interviewId = interviewOfLobby(call.lobby);
    const interview = interviewId ? await interviewById(interviewId).catch(() => null) : null;
    // A guest's request never reaches a model without a live interview of its own behind the call: the fixed sentence (not logged).
    if (isGuestId(request.askedBy) && (!interview || interview.state !== 'live' || !(await guestOfInterview(request.askedBy, interview.id).catch(() => false)))) return MILO_CAN_DO;
    if (!interview || interview.state !== 'live') return null;
    await loadTools();
    const tool = await phraseTool(INTERVIEW_FAMILY, request.text);
    // Only the lead's words introduce Milo; anyone else saying them is left to the model (which may call `introduce`, refused).
    if (!tool || (tool.name === 'introduce' && request.askedBy !== interview.leadId)) return null;
    const out = await runServerTool(call, request.askedBy, tool.name, {}, 'phrase').catch(() => null);
    return out?.line ?? '';
  },
  heldFallbackWait: { quietMs: 4_000, delegatedMs: 15_000 },
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
  // The pad's changes reach the live session (milo-tools `notePadChange`; review 1, item 7).
  const padNotes = onPadEventsAppended((interviewId, events) => {
    void import('./milo-tools/index.js').then(({ notePadChange }) => notePadChange(interviewId, events)).catch(() => false);
  });
  unregister = () => { policy(); rules(); padNotes(); };
  return true;
}

/** Tests: take the registration back. */
export function unregisterInterviewsMiloPolicy(): void { unregister?.(); unregister = null; }

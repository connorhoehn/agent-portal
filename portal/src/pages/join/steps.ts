// The candidate's steps (docs/interviews-tenant-plan.md row I2.3; decision 5): the pure model behind /join.
//
//   landing → consents → devices → waiting → admitted (the room, row I2.4) → ended
//                      ↘ held (row I6.4: the answers leave off a part this deployment requires; the call cannot start
//                        as set up until an answer changes)
//
// One step at a time. Which step a guest lands on comes from what the server holds: the answers stored under
// the current notice (C4) and the admission (C2). Nothing here is defaulted to yes: an unanswered question is
// null, and Milo goes back to unanswered (never to yes) when the transcript is turned back on.

export type JoinStep = 'landing' | 'consents' | 'devices' | 'waiting' | 'held' | 'admitted' | 'ended';

export type ConsentPart = 'recording' | 'transcription' | 'milo';
export type ConsentChoices = Record<ConsentPart, boolean | null>;

export interface ConsentNotice { version: string; title: string; paragraphs: string[] }
/** C4's answer to GET and PUT /api/interview-invite/consents. */
export interface GuestConsents {
  notice: ConsentNotice; answers: ConsentChoices; answeredAt: string | null;
  /** The parts this deployment needs for the call to start (row I6.4). Missing from an older server: none. */
  required?: ConsentPart[];
}

/** The required parts the answers say no to (row I6.4). An unanswered question declines nothing yet. */
export function declinedRequired(answers: ConsentChoices, required: readonly ConsentPart[] | undefined): ConsentPart[] {
  return (required ?? []).filter((p) => answers[p] === false);
}

/** The line beside a required question, before the candidate answers and after. */
export const REQUIRED_LINE = 'This interview needs this to go ahead.';

const PART_WORDS: Record<ConsentPart, string> = { recording: 'the recording', transcription: 'the transcript', milo: 'Milo' };

/** "the recording", "the transcript and Milo", "the recording, the transcript and Milo". */
export function partsInWords(parts: readonly ConsentPart[]): string {
  const words = parts.map((p) => PART_WORDS[p]);
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * What the held page says, in order (row I6.4): the answer is saved, the interview cannot start as it is set up, the
 * recruiter has been told and will be in touch, and the answer can change here until the interview starts. No blame,
 * no pressure, no countdown.
 */
export function heldLines(declined: readonly ConsentPart[]): string[] {
  const parts = partsInWords(declined);
  return [
    'Your answers are saved.',
    parts ? `This interview is set up to need ${parts}, so it cannot start as it is set up now.` : 'This interview cannot start as it is set up now.',
    'The recruiter has been told and will be in touch with you.',
    'You can change your answers on this page until the interview starts.',
  ];
}

export type AdmissionState = 'not-knocked' | 'waiting' | 'admitted' | 'turned-away';
/** C2's admission. */
export interface Admission { state: AdmissionState; knockedAt: string | null; decidedAt: string | null }

export const NOTHING_ANSWERED: ConsentChoices = Object.freeze({ recording: null, transcription: null, milo: null }) as ConsentChoices;

export function allAnswered(answers: ConsentChoices): boolean {
  return answers.recording !== null && answers.transcription !== null && answers.milo !== null;
}

/** Milo needs the transcript: with the transcript declined, Milo is declined and cannot be changed. */
export function miloLocked(answers: ConsentChoices): boolean {
  return answers.transcription === false;
}

/** One choice made on the page, with the transcript/Milo dependency applied as it happens. */
export function choose(answers: ConsentChoices, part: ConsentPart, value: boolean): ConsentChoices {
  if (part === 'milo' && miloLocked(answers)) return answers;
  const next = { ...answers, [part]: value };
  if (part === 'transcription') {
    if (!value) next.milo = false;
    // Turned back on: Milo is asked again, never assumed.
    else if (answers.transcription === false) next.milo = null;
  }
  return next;
}

/**
 * Where a guest lands when the page opens. The server's answers decide: an admitted guest goes to the call; a
 * guest who knocked goes back to waiting unless their answers no longer stand (the notice changed); a guest who
 * answered but never knocked goes to the device check (it is never skipped, and holds nothing); anyone else
 * starts at the landing. Answers that say no to a required part (row I6.4) land on the held page instead. A missing admission (the route is not there) counts as not knocked.
 */
export function landingStep(answers: ConsentChoices, admission: Admission | null, required?: readonly ConsentPart[]): JoinStep {
  const answered = allAnswered(answers);
  const state = admission?.state ?? 'not-knocked';
  if (state === 'admitted') return 'admitted';
  if (!answered) return 'landing';
  if (declinedRequired(answers, required).length) return 'held';
  if (state === 'waiting' || state === 'turned-away') return 'waiting';
  return 'devices';
}

/** After the consents: the held page when a required part is declined; else the device check once per visit, then waiting. */
export function stepAfterConsents(devicesChecked: boolean, saved?: Pick<GuestConsents, 'answers' | 'required'>): JoinStep {
  if (saved && declinedRequired(saved.answers, saved.required).length) return 'held';
  return devicesChecked ? 'waiting' : 'devices';
}

/** After a refused save (the call started, or another window saved first): the answers the server holds still stand
 *  when all three are answered, so the candidate may go back to waiting on them instead of being stuck on the answers. */
export function answersStand(held: Pick<GuestConsents, 'answers'> | null | undefined): boolean {
  return !!held && allAnswered(held.answers);
}

/** How often the waiting page asks, and for how long before it stops and offers to check again. */
export const ADMISSION_POLL_MS = 4000;
export const ADMISSION_MAX_POLLS = 450; // 30 minutes

/** What the waiting page shows for an admission. A missing route or answer is still waiting, never an error. */
export function waitingView(admission: Admission | null): 'waiting' | 'turned-away' | 'admitted' {
  if (admission?.state === 'admitted') return 'admitted';
  if (admission?.state === 'turned-away') return 'turned-away';
  return 'waiting';
}

// ── The room (row I2.4, the candidate's side; contract D1) ─────────────────────────────────────────────────────

/** D1's answer to GET /api/interview-invite/room. */
export interface GuestRoom {
  interviewId: string;
  lobbyName: string;
  self: { userId: string; displayName: string };
  round: { name: string; type: 'technical' | 'behavioural'; minutes: number };
  scheduledAt: string | null;
  startedAt: string | null;
  state: 'open' | 'ended';
  /** The lead's id in the call: whose tile carries the lead's name (E4 #32). Missing from an older server. */
  leadCallId?: string;
}

/** One read of the room: its answer, not-found (not let in now, or the link died), or no answer at all. */
export type RoomRead = { kind: 'room'; room: GuestRoom } | { kind: 'gone' } | { kind: 'failed' };

/** How often the room asks whether the interview is still on, and the bound: the round's length and an hour more. */
export const ROOM_POLL_MS = 5000;
export function roomMaxPolls(minutes: number): number {
  const length = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
  return Math.ceil(((length + 60) * 60_000) / ROOM_POLL_MS);
}

/**
 * Where a read of the room sends the candidate. `ended` and not-found both end the room: the interview is over,
 * the lead turned them away mid-call, or the link was taken back; the page leaves the call and shows the ended
 * page (it says nothing about why). A failed read changes nothing: the next read decides.
 */
export function roomStepAfterRead(read: RoomRead): 'admitted' | 'ended' | null {
  if (read.kind === 'gone') return 'ended';
  if (read.kind === 'room') return read.room.state === 'ended' ? 'ended' : 'admitted';
  return null;
}

/**
 * What the room shows while it is open. `unavailable`: guest realtime is off in this deployment (the token route is
 * not found), a plain line, never an error page. Before joining, and after leaving, the call is offered: `join`
 * the first time, `rejoin` after Leave. `call` once the candidate is in it.
 */
export type RoomView = 'loading' | 'unavailable' | 'join' | 'rejoin' | 'call';
export function roomView(f: { token: 'loading' | 'ready' | 'off'; joined: boolean; left: boolean }): RoomView {
  if (f.token === 'off') return 'unavailable';
  if (f.token === 'loading') return 'loading';
  if (f.joined) return 'call';
  return f.left ? 'rejoin' : 'join';
}

// ── The frame around the steps (UI round 2, lane GUEST) ────────────────────────────────────────────────────────

/** The four steps a candidate walks, as the strip over every step page names them. */
export const WALKED_STEPS = ['Invitation', 'Your answers', 'Camera and microphone', 'Waiting'] as const;

/** One mark of the strip: the library's `WorkflowStep` shape, without the import (this file stays pure). */
export interface WalkedStep { step: number; label: string; done: boolean; active: boolean }

/**
 * The strip for a step. The held page sits on "Your answers" (an answer has to change before the call can start);
 * the room and the ended page have walked all four. Each step before the active one is done.
 */
export function walkedSteps(step: JoinStep): WalkedStep[] {
  const at: Record<JoinStep, number> = { landing: 0, consents: 1, held: 1, devices: 2, waiting: 3, admitted: 4, ended: 4 };
  const current = at[step];
  return WALKED_STEPS.map((label, i) => ({ step: i + 1, label, done: i < current, active: i === current }));
}

/** Who sits on the candidate's panel, as `GET /api/interview-invite/interview` answers it: a name and a count, nothing else. */
export interface GuestPanel { lead: string | null; others: number }

/**
 * "You are meeting Hugo Marchetti." / "… and one other interviewer." / "… and 2 other interviewers." A lead the
 * server does not name reads as "your interviewer". Missing (an older server): null, and the page says nothing.
 */
export function meetingLine(panel: GuestPanel | null | undefined): string | null {
  if (!panel) return null;
  const who = panel.lead?.trim() || 'your interviewer';
  const others = Number.isFinite(panel.others) && panel.others > 0 ? Math.floor(panel.others) : 0;
  if (others === 0) return `You are meeting ${who}.`;
  return `You are meeting ${who} and ${others === 1 ? 'one other interviewer' : `${others} other interviewers`}.`;
}

/**
 * Where the candidate's bar counts the time left from while the call is on: the interview's start (the lead's
 * join), else the join this page saw. Never the set time, so a call held before it never reads "Starts in 1442 min".
 */
export function guestCallStartMs(interviewStartedAt: string | null | undefined, observedJoinMs: number | null | undefined): number | null {
  const started = interviewStartedAt ? Date.parse(interviewStartedAt) : NaN;
  if (Number.isFinite(started)) return started;
  return typeof observedJoinMs === 'number' && Number.isFinite(observedJoinMs) ? observedJoinMs : null;
}

// The candidate's steps (docs/interviews-tenant-plan.md row I2.3; decision 5): the pure model behind /join.
//
//   landing → consents → devices → waiting → admitted
//
// One step at a time. Which step a guest lands on comes from what the server holds: the answers stored under
// the current notice (C4) and the admission (C2). Nothing here is defaulted to yes: an unanswered question is
// null, and Milo goes back to unanswered (never to yes) when the transcript is turned back on.

export type JoinStep = 'landing' | 'consents' | 'devices' | 'waiting' | 'admitted';

export type ConsentPart = 'recording' | 'transcription' | 'milo';
export type ConsentChoices = Record<ConsentPart, boolean | null>;

export interface ConsentNotice { version: string; title: string; paragraphs: string[] }
/** C4's answer to GET and PUT /api/interview-invite/consents. */
export interface GuestConsents { notice: ConsentNotice; answers: ConsentChoices; answeredAt: string | null }

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
 * starts at the landing. A missing admission (the route is not there) counts as not knocked.
 */
export function landingStep(answers: ConsentChoices, admission: Admission | null): JoinStep {
  const answered = allAnswered(answers);
  const state = admission?.state ?? 'not-knocked';
  if (state === 'admitted') return 'admitted';
  if (!answered) return 'landing';
  if (state === 'waiting' || state === 'turned-away') return 'waiting';
  return 'devices';
}

/** After the consents: the device check once per visit, then straight back to waiting. */
export function stepAfterConsents(devicesChecked: boolean): JoinStep {
  return devicesChecked ? 'waiting' : 'devices';
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

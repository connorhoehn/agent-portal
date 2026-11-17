// What an interview runs with, from the candidate's three answers (docs/interviews-tenant-plan.md decision 5, row I2.5;
// contract D4). Pure: one table, read by Milo's invite (lib/interviews/milo-policy.ts), the recording decision platform-api
// asks (routes/realtime-lobby-access.ts, D2) and the recruiter's column and bell. The coach (COACH) holds the same rule
// through `consentsFor`: `coach` is true exactly when the transcript and Milo were both accepted.
//
//   recording         the recording answer alone.
//   transcript        the transcript answer alone.
//   coach             the transcript AND Milo: Milo reads the transcript, so without it there is nothing to read.
//   miloMayBeInvited  the transcript answer alone. Milo's live session IS the listener that makes the transcript, and it
//                     hears every microphone in the room, the candidate's included, whoever invites it. So with the
//                     transcript declined nobody may invite Milo into the call at all: the stricter reading of "the
//                     interview runs without that part", since a listener that only "ignores" the candidate would still
//                     hear them. With the transcript accepted and Milo declined, the listener may run for the transcript
//                     while the coach stays off (the candidate accepted being transcribed, not being advised on).
//   no answers        nothing runs: no recording, no transcript, no coach, and Milo may not be invited (decision 5:
//                     nothing of the candidate is recorded or transcribed before consent).
//
// The eight combinations, as built (recording, transcription, milo → recording, transcript, coach, miloMayBeInvited):
//   yes yes yes → on  on  on  yes        no  yes yes → off on  on  yes
//   yes yes no  → on  on  off yes        no  yes no  → off on  off yes
//   yes no  yes → on  off off no         no  no  yes → off off off no
//   yes no  no  → on  off off no         no  no  no  → off off off no
// (Milo answered yes with the transcript declined is stored as no by the consent rules; it reads the same here either way.)

export interface ConsentAnswersIn { recording: boolean; transcription: boolean; milo: boolean }
export interface InterviewRuns { recording: boolean; transcript: boolean; coach: boolean; miloMayBeInvited: boolean }

const NOTHING: InterviewRuns = Object.freeze({ recording: false, transcript: false, coach: false, miloMayBeInvited: false });

/** D4: what an interview runs with. Anything but a real `true` is a no; no answers run nothing. */
export function interviewRunsWith(answers: ConsentAnswersIn | null): InterviewRuns {
  if (!answers) return { ...NOTHING };
  const recording = answers.recording === true;
  const transcript = answers.transcription === true;
  const coach = transcript && answers.milo === true;
  return { recording, transcript, coach, miloMayBeInvited: transcript };
}

/** The parts the recruiter is told are off, in the notice's order. Every part when nothing is answered. */
export type OffPart = 'recording' | 'transcription' | 'milo';

export function partsOffOf(answers: ConsentAnswersIn | null): OffPart[] {
  const runs = interviewRunsWith(answers);
  const off: OffPart[] = [];
  if (!runs.recording) off.push('recording');
  if (!runs.transcript) off.push('transcription');
  if (!runs.coach) off.push('milo');
  return off;
}

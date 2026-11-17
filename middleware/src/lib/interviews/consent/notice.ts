// The notice the candidate reads before the three consents (docs/interviews-tenant-plan.md decision 5, row I2.3).
//
// A versioned text held in code. Every answer names the version it was given under, and an answer under any
// other version is refused, so the page shows the text again (rules.ts). Changing a word here means a new
// `version`: a candidate who answered the old text is asked again before they can knock.
//
// Plain words, nothing the product cannot keep. The periods are decision 17's defaults; a deployment may set
// others (and the deletion log and the periods themselves are row I6.3). No provider is named.

export interface ConsentNotice {
  version: string;
  title: string;
  paragraphs: string[];
}

export const CONSENT_NOTICE: ConsentNotice = Object.freeze({
  version: '2026-11-16.1',
  title: 'Before your interview: recording, transcript and Milo',
  paragraphs: Object.freeze([
    'Before you join, we ask you three separate questions. You can say yes or no to each one. Nothing of you is recorded or transcribed before you answer, and nothing is set to yes for you.',
    'Recording. If you agree, the video and sound of the call are recorded from the moment the interviewer starts the call until it ends. The people interviewing you are recorded too.',
    'Transcript. If you agree, what is said in the call is turned into text as it happens, with who said it.',
    'Milo. Milo is a software helper for the people interviewing you. If you agree, Milo reads the transcript and the code written in the call, suggests questions to your interviewer, and afterwards writes notes that point to the moments they come from. Milo does not score you, does not recommend whether to hire you, and does not judge your face, your voice or your tone. Milo needs the transcript, so if you say no to the transcript, Milo is off too.',
    'Who sees it. The recording, the transcript and Milo\'s notes are seen only by the people running your interview: the recruiter, your interviewers and the hiring manager. You are not shown them.',
    'How long it is kept. Unless the company running the interview has set different periods, the recording, the transcript and the code log are kept for 90 days, and the record of your answers here, the interviewers\' scorecards and the log of what Milo showed them are kept for four years.',
    'Saying no. You can say no to any of the three. The interview still goes ahead without that part: with no recording, or with no transcript and no Milo. Your interviewer is told only which parts are off, and the recruiter is told so they can arrange what replaces them. Your answers are not written on any scorecard.',
    'Changing your mind. You can change your answers on this page until the interview starts.',
    'Asking for deletion. To have your recording and transcript deleted, ask the person who sent you your interview link. They are removed within 30 days; a note that they were removed is kept, and the record of your answers stays for its period with your contact details taken out.',
  ]) as string[],
}) as ConsentNotice;

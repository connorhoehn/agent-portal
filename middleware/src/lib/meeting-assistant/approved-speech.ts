// Approved speech: words the server holds, said aloud on the call's own live session (docs/interviews-tenant-plan.md decision 9).
//
// The one gate and the one relay stay as they are (voice-gate.ts, voice.ts). What this adds is the check in front of them for ONE
// kind of utterance: the session is asked to say a text verbatim (session.ts `sayVerbatim`), and the utterance it produces is held
// WHOLE, in memory, until the session's own transcript of it is complete. Only when that transcript is the same words as the text
// (case, punctuation and spacing aside) are its frames handed to the gate, which opens for them with the reason `approved`. On any
// difference, no words, no audio, or nothing complete inside `sayBoundMs`, the utterance is withheld whole: nothing of it is sent.
// Nothing is ever relayed frame by frame as it arrives.
//
// Pure: no clock, no session, no relay; the orchestrator (`sayHeldText`) does the holding and the sending.

/** The words of a text, for comparing what was asked with what was said: lower case, letters and digits, single spaces. */
export function spokenWords(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Did the session say exactly these words? Empty never matches. */
export function saidVerbatim(asked: string, transcript: string | null | undefined): boolean {
  const a = spokenWords(asked);
  return a.length > 0 && a === spokenWords(transcript);
}

/** The shortest and longest time an approved utterance may take, from the request to its last frame and its final transcript. */
export const SAY_MIN_BOUND_MS = 8_000;
export const SAY_MAX_BOUND_MS = 45_000;
/** Allowed per character on top of the minimum (speech runs at about 15 characters a second; this is half that speed). */
export const SAY_MS_PER_CHAR = 70;

/** How long the orchestrator waits for the utterance of `text` before it withholds it whole. */
export function sayBoundMs(text: string): number {
  return Math.min(SAY_MAX_BOUND_MS, SAY_MIN_BOUND_MS + SAY_MS_PER_CHAR * text.length);
}

/** What became of an approved utterance: relayed (`spoken`), or in chat only (`posted`); `no-call` when Milo has no run in the call. */
export type SayOutcome = 'spoken' | 'posted' | 'no-call';

/** Why an approved utterance was not relayed: codes only, for the trace. */
export type SayWithheldWhy = 'empty' | 'no-say' | 'voice-off' | 'paused' | 'busy' | 'refused' | 'timeout' | 'no-words' | 'mismatch' | 'no-audio' | 'not-relayed' | 'session-changed' | 'closed';

/** The one plain sentence the lead reads when the words could not be said aloud. */
export const NOT_SAID_ALOUD = 'Milo could not say it aloud. The question is in the call chat.';

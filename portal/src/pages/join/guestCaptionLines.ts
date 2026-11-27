// The candidate's own live captions (gap audit 2026-11-20 §11): what the page does with GET /api/interview-invite/captions.
// Pure, so the wording, the merge and the bound are tested without a browser (__tests__/guestCaptionLines.test.ts).
//
// The server answers each line as its seq, a speaker class and its text, and nothing else; the page shows the class as a word
// ("You", "Interviewer", "Milo") and the text as text. The read answers only while the deployment offers captions, the round
// is live, the candidate was let in and their answer accepted the transcript.

export type CaptionSpeaker = 'you' | 'interviewer' | 'milo';
export interface CaptionLine { seq: number; speaker: CaptionSpeaker; text: string }
export interface CaptionsRead { running: boolean; lines: CaptionLine[]; lastSeq: number }

/** How often the page asks for new lines: quicker than the panel's five seconds, inside the route's 60 a minute. */
export const CAPTIONS_POLL_MS = 2_500;
/** The most lines the page keeps on screen (older ones scroll away for good). */
export const CAPTIONS_KEPT = 200;

/** The reads one room may make: the round's length and half an hour more, so a forgotten tab stops asking. */
export function captionsMaxReads(minutes: number): number {
  const length = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
  return Math.ceil(((length + 30) * 60_000) / CAPTIONS_POLL_MS);
}

const LABEL: Record<CaptionSpeaker, string> = { you: 'You', interviewer: 'Interviewer', milo: 'Milo' };
/** The word shown for who spoke. An unknown class reads as the panel, never as the candidate. */
export const captionSpeakerLabel = (speaker: string): string => LABEL[speaker as CaptionSpeaker] ?? LABEL.interviewer;

/** The held lines and the new ones, by seq, oldest first, without repeats, at most `kept`. */
export function mergeCaptions(held: readonly CaptionLine[], incoming: readonly CaptionLine[], kept: number = CAPTIONS_KEPT): CaptionLine[] {
  const bySeq = new Map<number, CaptionLine>();
  for (const l of held) bySeq.set(l.seq, l);
  for (const l of incoming) if (Number.isInteger(l.seq) && typeof l.text === 'string') bySeq.set(l.seq, { seq: l.seq, speaker: l.speaker, text: l.text });
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-Math.max(0, kept));
}

/** What a screen reader is told when a line arrives: who and the words. Empty when there is nothing. */
export const captionAnnouncement = (line: CaptionLine | undefined): string => (line ? `${captionSpeakerLabel(line.speaker)}: ${line.text}` : '');

/** The one sentence shown when the candidate declined the transcript: why, and no ask to change it. */
export const CAPTIONS_DECLINED = 'There are no captions in this call because you chose to go without a transcript.';
/** Shown while the read answers but no transcript runs in the call yet. */
export const CAPTIONS_NOT_RUNNING = 'Captions start when the transcript starts in the call.';
/** Shown while the transcript runs and nothing has been said yet. */
export const CAPTIONS_EMPTY = 'Nothing has been said yet.';

/** What the captions area shows: nothing (not offered), the declined sentence, or the captions. */
export function captionsMode(offered: boolean | undefined, transcriptAccepted: boolean | null): 'none' | 'declined' | 'captions' {
  if (!offered) return 'none';
  if (transcriptAccepted === false) return 'declined';
  return transcriptAccepted ? 'captions' : 'none';
}

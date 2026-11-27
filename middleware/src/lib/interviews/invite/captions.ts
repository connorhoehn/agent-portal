// The candidate's own live captions (gap audit 2026-11-20 §11; ledger row C-11): GET /api/interview-invite/captions?after=<seq>.
//
// The same lines the panel's live transcript reads (milo-notes/transcript.ts `assistantLiveTranscript`), as they are stored,
// with no delay and no edit, cut down to what a caption needs: the words, which of three kinds of speaker said them, and the
// line's sequence number so the page asks only for what is new. Never a name, a user id or a time.
//
//   who      the guest's own session (requireGuest); the interview is the session's, never sent.
//   when     the interview is live, the lead has let this guest in, and the candidate's recorded answer accepted the
//            transcript. Anything else is the guest's one not-found (null here).
//   whether  INTERVIEWS_CANDIDATE_CAPTIONS is `on`. Off by default: the notice the candidate accepted (consent/notice.ts,
//            version 2026-11-16.1) says the transcript is seen only by the people running the interview and "You are not
//            shown them", so showing it to the candidate needs a notice version that says so first. Read on every request.
//
// A line nobody's audio was attributed to is already left out by the source, as the panel's view leaves it out.
import { isAssistantUserId } from '../../meeting-assistant/chat-types.js';
import { isGuestId } from '../guest-id.js';
import { assistantLiveTranscript, type LiveLine, type LiveTranscriptSource } from '../milo-notes/transcript.js';

export const CANDIDATE_CAPTIONS_SETTING = 'INTERVIEWS_CANDIDATE_CAPTIONS';

/** True only when the deployment sets the value to `on`. Never throws. */
export function candidateCaptionsOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CANDIDATE_CAPTIONS_SETTING]?.trim().toLowerCase() === 'on';
}

/** The most lines one read answers: the newest ones after `after`. The page follows from `lastSeq`. */
export const CAPTIONS_MAX_LINES = 50;

export type CaptionSpeaker = 'you' | 'interviewer' | 'milo';
/** One caption line: exactly these three keys. */
export interface CaptionLine { seq: number; speaker: CaptionSpeaker; text: string }
export interface CaptionsBody {
  captions: {
    /** False while no transcript runs in the call yet (Milo, which transcribes it, has not been invited). */
    running: boolean;
    lines: CaptionLine[];
    /** The newest seq read, attributed or not; `after` when nothing is newer. */
    lastSeq: number;
  };
}

/** The candidate is the interview's only guest; the assistant is Milo; everyone else in the call sits on the panel. */
export function captionSpeakerOf(userId: string): CaptionSpeaker {
  if (isGuestId(userId)) return 'you';
  if (isAssistantUserId(userId)) return 'milo';
  return 'interviewer';
}

/** The newest `max` lines, each cut to its seq, its speaker class and its text. Pure. */
export function captionLinesOf(lines: readonly LiveLine[], max: number = CAPTIONS_MAX_LINES): CaptionLine[] {
  return lines.slice(-Math.max(0, max)).map((l) => ({ seq: l.seq, speaker: captionSpeakerOf(l.userId), text: l.text }));
}

/** `after` from the query: a non-negative integer, else 0. */
export function captionsAfter(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? '0'), 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export interface CaptionsGate {
  enabled: boolean;
  interview: { id: string; callId: string | null; state: string } | null;
  /** The invite belongs to this interview and the lead has let its guest in. */
  admitted: boolean;
  consent: { transcription: boolean } | null;
}

/** Whether the read answers at all. Pure. */
export function captionsAllowed(g: CaptionsGate): boolean {
  return g.enabled && g.interview !== null && g.interview.state === 'live' && g.admitted && g.consent?.transcription === true;
}

let sourceOverride: LiveTranscriptSource | null = null;
/** Tests: stand in for the assistant's transcript store; `null` puts the real one back. */
export function setCaptionsSource(next: LiveTranscriptSource | null): void { sourceOverride = next; }

/** The answer, or null for the guest's one not-found. */
export async function guestCaptions(g: CaptionsGate, after: number, source: LiveTranscriptSource = sourceOverride ?? assistantLiveTranscript): Promise<CaptionsBody | null> {
  if (!captionsAllowed(g) || !g.interview) return null;
  const from = Math.max(0, after);
  const t = await source({ id: g.interview.id, callId: g.interview.callId }, from);
  if (!t) return { captions: { running: false, lines: [], lastSeq: from } };
  return { captions: { running: true, lines: captionLinesOf(t.lines), lastSeq: t.lastSeq } };
}

// The candidate's caption for what Milo says in the call (GuestMiloVoice.tsx draws it). Pure, so the kind, the label and the
// clearing are tested without a page (__tests__/guestMiloCaption.test.ts).
//
// Two sources feed one caption: Milo's lines in the call chat (a question it asked, or something it said: its introduction, a
// confirmation), and the server's answer to one of the candidate's two requests ("Repeat the question", "How much time is left?"),
// which Milo also says aloud. The newest wins; one caption shows at a time.
import type { MiloLastLine } from '../../lib/interviewsRoom';

export type MiloCaptionKind = 'question' | 'said';
export type MiloCaptionSource = 'chat' | 'request';

export interface MiloCaption {
  /** Bumped for every caption shown, so the live region re-reads a repeated question. */
  seq: number;
  text: string;
  kind: MiloCaptionKind;
  source: MiloCaptionSource;
  /** When it arrived (ms). */
  at: number;
}

/** The answer to one of the candidate's requests: the server's sentence, or (not ok) a sentence of ours when it did not answer. */
export interface MiloRequestAnswer { text: string; ok: boolean; at: number }

/** The speaker, as the call chat names Milo's rows. */
export const MILO_CAPTION_SPEAKER = 'Milo';

/** The kind marker beside the speaker: a question is marked, anything else Milo says is not. */
export const captionKindLabel = (kind: MiloCaptionKind): string | null => (kind === 'question' ? 'Question' : null);

export const captionFromChat = (line: MiloLastLine, seq: number, at: number): MiloCaption =>
  ({ seq, text: line.text, kind: line.asked ? 'question' : 'said', source: 'chat', at: line.at ?? at });

/** A line sent longer ago than its caption would be held (a history replay to a rejoining candidate) is not shown or read. */
export const lineIsStale = (line: MiloLastLine, now: number): boolean =>
  line.at !== undefined && now - line.at >= captionHoldMs({ text: line.text, kind: line.asked ? 'question' : 'said' });

/**
 * The answer to a request, as a caption. "Repeat the question" answers with the question itself: that is the question again (a
 * question caption, re-announced), not a second copy as something said.
 */
export function captionFromRequest(answer: MiloRequestAnswer, lastAsked: MiloLastLine | null, seq: number): MiloCaption {
  const text = answer.text.trim();
  const repeat = !!lastAsked?.asked && text === lastAsked.text.trim();
  return { seq, text, kind: repeat ? 'question' : 'said', source: repeat ? 'chat' : 'request', at: answer.at };
}

/** A line the caption already shows, arriving again within this window (a repeat's chat echo, a history replay), is not re-shown. */
export const CAPTION_ECHO_MS = 15_000;

/** Whether `next` replaces `cur`: always, unless it is the same words of the same kind that arrived moments ago. */
export function replacesCaption(cur: MiloCaption | null, next: MiloCaption): boolean {
  if (!cur) return true;
  return !(cur.text === next.text && cur.kind === next.kind && next.at - cur.at < CAPTION_ECHO_MS);
}

/** About 170 words a minute, a comfortable reading pace for a caption. */
const READ_MS_PER_WORD = 350;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * How long a caption stays after Milo stops speaking. A question stays long enough to think about and start answering (the
 * candidate can also ask for it again); a confirmation, the introduction or the time only long enough to read twice.
 */
export function captionHoldMs(c: Pick<MiloCaption, 'text' | 'kind'>): number {
  const words = c.text.split(/\s+/).filter(Boolean).length;
  const read = words * READ_MS_PER_WORD;
  return c.kind === 'question' ? clamp(read + 20_000, 25_000, 60_000) : clamp(read + 4_000, 8_000, 20_000);
}

/**
 * When the caption clears: its hold, counted from when it arrived or from when Milo's voice last stopped, whichever is later. While
 * Milo is still speaking it never clears (null). The next line replaces it before then.
 */
export function captionClearsAt(c: MiloCaption, speaking: boolean, speakingEndedAt: number | null): number | null {
  if (speaking) return null;
  return Math.max(c.at, speakingEndedAt ?? 0) + captionHoldMs(c);
}

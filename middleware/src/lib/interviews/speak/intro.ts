// Milo introduces itself, once an interview (docs/interviews-tenant-plan.md, "Milo introduces itself").
//
// The words are fixed and held by the server (MILO_INTRO); no model writes them. Only the interview's LEAD asks for them, two
// ways that end on the same path:
//   * the lead's footer button "Introduce Milo" (routes/interviews/milo.ts POST /interviews/:id/milo-intro), which logs, posts
//     and says them through `sayApproved` (./index.ts), as "Have Milo ask" does;
//   * the lead saying it in the call, addressed to Milo ("Milo's here as our AI support", "Milo, introduce yourself"): found by
//     the meeting assistant's detector and answered by the interviews policy (milo-policy.ts `answerFromHeldText`) with these
//     words, logged here; the orchestrator posts them with the approved mark and says them as approved words.
// Either way it is the one speaking path: logged first, posted, then said verbatim under the voice gate's `approved` reason,
// one utterance at a time and only into quiet, behind the speech hold. Once a row with these words has reached the call chat
// (`posted`), Milo has introduced itself in this interview and neither way says them again.
import { interviewsNowMs } from '../clock.js';
import type { Interview } from '../types.js';
import { sayApproved, type Said } from './index.js';
import { saidStore, type SaidRecord } from './store.js';

/** What Milo says when the lead introduces it. */
export const MILO_INTRO = "Hi, I'm Milo. I'm here to take notes and help with logistics. I won't judge your answers, and you can ask me things like how much time is left.";

/** The lead's receipt when Milo has already introduced itself in this interview. */
export const ALREADY_INTRODUCED = 'Milo has already introduced itself in this interview.';

// The lead's spoken introduction, read from the words after Milo's name (the detector drops the name and what came before it):
// "<Milo>'s here …", "<Milo> is here …", "<Milo> is joining us …", or "<Milo>, introduce yourself / say hello / say hi …".
const utterance = (text: string): string => text.toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const HERE = /^(?:s|is)?\s*(?:here|joining\s+us|with\s+us|on\s+the\s+call)(?:\s|$)/;
const ASKED = /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:introduce\s+yourself|say\s+(?:hello|hi)|tell\s+(?:them|us|everyone|the\s+candidate)\s+(?:who|what)\s+you\s+are)(?:\s|$)/;
/** At most this many words: an introduction is short; a long sentence that happens to start "Milo's here" is anything else. */
const MAX_WORDS = 14;

/** Is this the lead introducing Milo (the words after its name)? */
export function isIntroduction(text: string): boolean {
  const t = utterance(text);
  return t.split(' ').length <= MAX_WORDS && (HERE.test(t) || ASKED.test(t));
}

/** How long a spoken introduction logged but not yet posted counts as on its way (the orchestrator posts it within seconds). */
export const INTRO_PENDING_MS = 60_000;

/**
 * Has Milo introduced itself in this interview: an `intro` row that reached the call chat, or (`pending`) one logged moments ago
 * by the spoken path and on its way there. The button counts only what was posted: a press while Milo was not in the call
 * logged a row that never reached it, and a press once Milo is in must still work.
 */
export const introduced = (rows: readonly SaidRecord[], nowMs: number, pending: boolean): boolean =>
  rows.some((r) => r.source === 'intro' && (r.posted || (pending && nowMs - Date.parse(r.saidAt) < INTRO_PENDING_MS)));

/** One introduction at a time per interview (the check and the add run with no await between them). */
const inFlight = new Set<string>();

/** The lead's button: Milo's introduction logged, posted and said, unless it was already given. */
export async function introduceMilo(interview: Pick<Interview, 'id' | 'callId'>, leadId: string): Promise<{ said: Said; line: string } | 'already'> {
  if (inFlight.has(interview.id)) return 'already';
  inFlight.add(interview.id);
  try {
    if (introduced(await saidStore().list(interview.id), interviewsNowMs(), false)) return 'already';
    const { said } = await sayApproved(interview, { kind: 'answer', source: 'intro', text: MILO_INTRO, askedBy: leadId });
    return { said, line: MILO_INTRO };
  } finally {
    inFlight.delete(interview.id);
  }
}

/**
 * The spoken half (milo-policy.ts `answerFromHeldText` for the lead): the words, logged as an answer not yet posted, or null when
 * Milo has introduced itself already (the request is then nobody's held text, as before). The orchestrator posts and says them.
 */
export async function logIntroduction(interview: Pick<Interview, 'id' | 'callId'>, leadId: string, now: () => number, newId: () => string): Promise<string | null> {
  if (inFlight.has(interview.id)) return null;
  inFlight.add(interview.id);
  try {
    const store = saidStore();
    if (introduced(await store.list(interview.id), now(), true)) return null;
    await store.append({
      id: newId(), interviewId: interview.id, callId: interview.callId, kind: 'answer', source: 'intro', questionId: null, suggestionId: null,
      text: MILO_INTRO, askedBy: leadId, saidAt: new Date(now()).toISOString(), posted: false, spoken: false,
    });
    return MILO_INTRO;
  } finally {
    inFlight.delete(interview.id);
  }
}

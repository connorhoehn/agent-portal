// The coach's clarifying-question nudge (WHITEBOARD-PLAN step 2b): rules only, no model call. A system design question
// carries the clarifying questions a strong candidate asks before drawing (kit.ts `clarifying`); when a whiteboard
// round is a few minutes in and the candidate has asked none of them, the lead is shown one, once per interview, as an
// ordinary suggestion (the same card, the same Ask / Have Milo ask / Skip answers, the same log).
//
// Pure: the service (service.ts) gathers the facts, this decides, a test walks every branch. In order, the first
// that applies says no nudge:
//   the round is not on the whiteboard, or has not started;
//   it is under CLARIFY_AFTER_MS in (give the candidate the time to ask) or past CLARIFY_UNTIL_MS (the moment passed);
//   the interview already had this nudge (it is logged under CLARIFYING_MODEL_ID);
//   none of the round's questions carries clarifying questions;
//   a candidate line asked one: it shares two of a clarifying question's words, or it is a question ("?") sharing one
//   of them or a word every clarifying question is about (users, scale, latency, ...).
// Otherwise the nudge names the question's first clarifying question.
//
// The nudge's text is a note to the lead (it names what a strong candidate would ask). "Have Milo ask" on it never says
// that note: Milo says CLARIFY_INVITATION, a neutral invitation that gives the candidate no answer (`askedWords`).
import type { RoundSurface } from '../types.js';
import type { CoachLine } from './prompt.js';
import type { SuggestionRecord } from './store.js';

export const CLARIFY_AFTER_MS = 4 * 60_000;
export const CLARIFY_UNTIL_MS = 15 * 60_000;
/** The log's `modelId` and `promptVersion` for this rule's rows: no model ran. */
export const CLARIFYING_MODEL_ID = 'rules:clarifying';
export const CLARIFYING_RULE_VERSION = 'clarifying-1';
/** What Milo says to the candidate when the lead answers the nudge with "Have Milo ask". */
export const CLARIFY_INVITATION = 'Before you start, is there anything you\'d like to clarify about the problem?';

/** The words Milo puts to the candidate for a suggestion the lead sent with "Have Milo ask". */
export function askedWords(row: Pick<SuggestionRecord, 'modelId' | 'text'>): string {
  return row.modelId === CLARIFYING_MODEL_ID ? CLARIFY_INVITATION : row.text;
}

export interface ClarifyFacts {
  surface: RoundSurface | null;
  startedAtMs: number | null;
  nowMs: number;
  /** The round's questions (the chosen ones, else the kit's for the round's type), in order. */
  questions: ReadonlyArray<{ id: string; competencyId: string; clarifying?: readonly string[] }>;
  lines: readonly CoachLine[];
  log: readonly SuggestionRecord[];
}

export interface ClarifyNudge { questionId: string; competencyId: string; expected: string; text: string }

const STOP = new Set([
  'what', 'which', 'when', 'where', 'who', 'whom', 'whose', 'why', 'how', 'does', 'that', 'this', 'with', 'from', 'have', 'must', 'there',
  'they', 'them', 'their', 'about', 'would', 'could', 'should', 'much', 'many', 'into', 'your', 'will', 'just', 'like', 'also', 'than',
  'then', 'some', 'each', 'need', 'want', 'what\'s', 'okay', 'yeah', 'think', 'going', 'make', 'sure', 'and', 'the', 'for', 'are', 'can',
]);
/** Words any clarifying question is about: a "?" line with one of these counts as asking. */
const TOPICS = new Set(['user', 'scale', 'traffic', 'peak', 'read', 'write', 'latency', 'consistency', 'consistent', 'region', 'requirement',
  'load', 'volume', 'second', 'size', 'storage', 'availability', 'durable', 'durability', 'expire', 'fresh', 'freshness']);

/** A line's meaningful words: lower case, four letters or more, not a stop word, a plural's `s` dropped. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const w = raw.replace(/'s$/, '');
    if (w.length < 4 || STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

const overlap = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => { let n = 0; for (const w of a) if (b.has(w)) n++; return n; };

/** Did this candidate line ask this clarifying question (or one like it)? */
export function asks(line: string, expected: string): boolean {
  const said = keywords(line);
  const want = keywords(expected);
  if (overlap(said, want) >= Math.min(2, want.size)) return want.size > 0;
  if (!line.includes('?')) return false;
  return overlap(said, want) >= 1 || [...said].some((w) => TOPICS.has(w));
}

export function clarifyingNudge(f: ClarifyFacts): ClarifyNudge | null {
  if (f.surface !== 'board' || f.startedAtMs === null) return null;
  const elapsed = f.nowMs - f.startedAtMs;
  if (elapsed < CLARIFY_AFTER_MS || elapsed > CLARIFY_UNTIL_MS) return null;
  if (f.log.some((r) => r.modelId === CLARIFYING_MODEL_ID)) return null;
  const q = f.questions.find((x) => (x.clarifying ?? []).some((c) => c.trim()));
  if (!q) return null;
  const expected = (q.clarifying ?? []).filter((c) => c.trim());
  const candidate = f.lines.filter((l) => l.side === 'candidate').map((l) => l.text);
  if (candidate.some((line) => expected.some((c) => asks(line, c)))) return null;
  const pick = expected[0]!;
  return {
    questionId: q.id, competencyId: q.competencyId, expected: pick,
    text: `No clarifying questions from the candidate yet. Invite one before they draw; a strong candidate would ask, for example: "${pick}"`,
  };
}

// The scorecard's rules (docs/interviews-tenant-plan.md row I5.3; decisions 6, 14, 15, 20). Pure functions: the
// route (routes/interviews/scorecards.ts) decides who is asking and the store (ScorecardWrites, InterviewWrites
// markScored) only writes.
//
//   who      the lead and each panel member of the interview, each for themselves (decision 20). The author is
//            always the signed-in person: the body has no field naming one, so nobody submits for someone else.
//            Milo never writes one (decision 6): there is no route, no field and no default a model could fill.
//   when     once the interview is `ended`; a correction also while it is `scored` (and nothing after review).
//   what     each competency the round assesses (kit.ts competenciesOfRound) rated 1 to 4 against its anchors; the
//            kit's other competencies are neither shown nor accepted, except one the author's own earlier version
//            rated, which a correction may keep (scorecardCompetencies). A note per rated competency allowed, a
//            recommendation (strong no, no, yes, strong yes) and a summary. SCORECARD_LIMITS says how long.
//   versions a submitted scorecard is never edited: a correction is a new version with a reason, made against the
//            latest version the page read (stale otherwise). Every version stays and is read by whoever may read
//            the scorecard.
//   scored   the interview moves to `scored` when every seated person's scorecard is in.
//   hidden   who reads whose scorecard is scope.ts (`othersRevealed`): an interviewer reads the others' on a
//            candidate only once their own is in.
//
// RECAP STEP (row I5.2): the recap is opened between rating and the recommendation. The server stores the ratings
// as they stood when each person first opened it (lib/interviews/recap, POST …/recap/open); the submit's route reads
// that stored open (`ratingsAtRecap`), never the request, and `changedAfterRecap` below compares against it, for the
// first version and for every correction alike. Never opened: null, and it stays false.

import { seatOf } from './assign.js';
import { competenciesOfRound } from './kit.js';
import type { CompetencyRating, Interview, InterviewState, KitCompetency, OpeningKit, Recommendation, Scorecard } from './types.js';
import { RECOMMENDATIONS } from './types.js';

export const SCORECARD_LIMITS = {
  /** A note on one competency: optional. */
  noteChars: 2000,
  /** The summary: required. */
  summaryChars: 4000,
  /** Why a correction was made: required on a correction. */
  reasonChars: 1000,
} as const;

/** What a person sends: their ratings, their go or no-go, their summary; a correction adds why. */
export interface ScorecardInput {
  ratings: CompetencyRating[];
  recommendation: Recommendation;
  summary: string;
}

export type FieldProblem = { field: string; message: string };
export type Checked<T> = { ok: true; value: T } | { ok: false; fields: FieldProblem[] };

/** The keys a submit may carry. Anything else (an author, a version number, a recap flag) is refused. */
const BODY_KEYS: ReadonlySet<string> = new Set(['ratings', 'recommendation', 'summary', 'reason', 'basedOn']);

/** States in which a seated person may submit: the first version once it has ended, a correction while scored too. */
const SUBMITTABLE: ReadonlySet<InterviewState> = new Set(['ended', 'scored']);

export type SubmitMove =
  | { ok: true; version: number }
  | { ok: false; reason: 'no-seat' | 'state' | 'stale' | 'needs-reason'; message: string };

export const NO_SCORECARD_HERE = 'There is no interview here that you can open.';

/** Whose scorecards are these, and in which versions: latest first per author is `latestByAuthor`. */
export function versionsOf(cards: readonly Scorecard[], interviewId: string, interviewerId: string): Scorecard[] {
  return cards.filter((s) => s.interviewId === interviewId && s.interviewerId === interviewerId).sort((a, b) => a.version - b.version);
}

/** The latest version of each author's scorecard on each interview, in the store's order (submitted, then id). */
export function latestByAuthor(cards: readonly Scorecard[]): Scorecard[] {
  const latest = new Map<string, Scorecard>();
  for (const s of cards) {
    const key = `${s.interviewId}\u0000${s.interviewerId}`;
    const was = latest.get(key);
    if (!was || s.version > was.version) latest.set(key, s);
  }
  return cards.filter((s) => latest.get(`${s.interviewId}\u0000${s.interviewerId}`) === s);
}

/** Why a seated person cannot submit now, in one sentence; null when they can. */
export function stateRefusal(state: InterviewState, hasOwn: boolean): string | null {
  if (SUBMITTABLE.has(state)) return null;
  if (state === 'reviewed') return hasOwn ? 'This interview has been reviewed, so its scorecards can no longer be corrected.' : 'This interview has been reviewed.';
  if (state === 'declined' || state === 'cancelled') return 'This interview did not go ahead, so there is nothing to rate.';
  return 'You can fill in the scorecard once the interview has ended.';
}

/**
 * May `userId` submit on `i` now, against `basedOn` (the latest version the page read; 0 for none)? Answers the
 * version the new scorecard gets. `mine` is every version of their own scorecard on this interview.
 */
export function submitMove(i: Pick<Interview, 'leadId' | 'panelIds' | 'state'>, userId: string, mine: readonly Scorecard[], basedOn: number, hasReason: boolean): SubmitMove {
  if (!seatOf(i, userId)) return { ok: false, reason: 'no-seat', message: NO_SCORECARD_HERE };
  const latest = mine.reduce((n, s) => Math.max(n, s.version), 0);
  const refusal = stateRefusal(i.state, latest > 0);
  if (refusal) return { ok: false, reason: 'state', message: refusal };
  if (basedOn !== latest) {
    return { ok: false, reason: 'stale', message: latest > 0 ? 'Your scorecard was submitted from another window. The page now shows what was saved.' : 'This page is out of date. Reload it and try again.' };
  }
  if (latest > 0 && !hasReason) return { ok: false, reason: 'needs-reason', message: 'Say why you are correcting your scorecard.' };
  return { ok: true, version: latest + 1 };
}

/**
 * What a scorecard on interview `i` rates: `required`, the competencies its round assesses (competenciesOfRound), and
 * `competencies`, those plus any the author's own latest version rated outside them (a round whose competencies were
 * narrowed after it was rated), so a correction keeps what was rated and nothing is dropped from a submitted card.
 * Both in the kit's order. The kit's other competencies are not shown and not accepted.
 */
export function scorecardCompetencies(
  i: Pick<Interview, 'roundId'>, kit: Pick<OpeningKit, 'rounds' | 'competencies'>, mine: readonly Pick<Scorecard, 'version' | 'ratings'>[] = [],
): { competencies: KitCompetency[]; required: string[] } {
  const round = competenciesOfRound(kit, i.roundId);
  const latest = mine.reduce<Pick<Scorecard, 'version' | 'ratings'> | null>((a, s) => (!a || s.version > a.version ? s : a), null);
  const keep = new Set([...round.map((c) => c.id), ...(latest?.ratings ?? []).map((r) => r.competencyId)]);
  return { competencies: kit.competencies.filter((c) => keep.has(c.id)), required: round.map((c) => c.id) };
}

/**
 * Check a submit's body against `competencies` (what this scorecard rates, scorecardCompetencies): every one in
 * `required` rated (default: all of them), the rest optional, anything else refused. A correction must carry a
 * reason; a first version must not.
 */
export function checkScorecard(body: unknown, competencies: readonly KitCompetency[], required: readonly string[] = competencies.map((c) => c.id)): Checked<ScorecardInput & { reason: string | null; basedOn: number }> {
  const fields: FieldProblem[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, fields: [{ field: 'body', message: 'Send the scorecard as a form.' }] };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => !BODY_KEYS.has(k));
  if (extra.length) fields.push({ field: extra[0]!, message: 'A scorecard carries only your ratings, notes, recommendation and summary.' });

  const basedOn = b['basedOn'] === undefined ? 0 : b['basedOn'];
  if (typeof basedOn !== 'number' || !Number.isInteger(basedOn) || basedOn < 0) fields.push({ field: 'basedOn', message: 'This page is out of date. Reload it and try again.' });

  const known = new Map(competencies.map((c) => [c.id, c]));
  const ratings: CompetencyRating[] = [];
  const raw = Array.isArray(b['ratings']) ? (b['ratings'] as unknown[]) : null;
  if (!raw) fields.push({ field: 'ratings', message: 'Rate the competencies this round judges.' });
  const seen = new Set<string>();
  for (const r of raw ?? []) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const id = typeof o['competencyId'] === 'string' ? o['competencyId'] : '';
    const c = known.get(id);
    if (!c) { fields.push({ field: 'ratings', message: 'One of the ratings is for a competency this round does not judge. Reload the page.' }); continue; }
    if (seen.has(id)) { fields.push({ field: `ratings.${id}`, message: `${c.name} is rated twice.` }); continue; }
    seen.add(id);
    const rating = o['rating'];
    if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) { fields.push({ field: `ratings.${id}`, message: `Rate ${c.name} from 1 to 4.` }); continue; }
    const note = o['note'] === undefined || o['note'] === null ? '' : o['note'];
    if (typeof note !== 'string') { fields.push({ field: `ratings.${id}.note`, message: `The note on ${c.name} must be text.` }); continue; }
    if (note.trim().length > SCORECARD_LIMITS.noteChars) { fields.push({ field: `ratings.${id}.note`, message: `Keep the note on ${c.name} under ${SCORECARD_LIMITS.noteChars} characters.` }); continue; }
    ratings.push({ competencyId: id, rating, note: note.trim() });
  }
  if (raw) {
    for (const c of competencies) if (required.includes(c.id) && !seen.has(c.id)) fields.push({ field: `ratings.${c.id}`, message: `Rate ${c.name}.` });
  }

  const recommendation = b['recommendation'];
  if (typeof recommendation !== 'string' || !(RECOMMENDATIONS as readonly string[]).includes(recommendation)) {
    fields.push({ field: 'recommendation', message: 'Choose your recommendation: strong no, no, yes or strong yes.' });
  }
  const summary = typeof b['summary'] === 'string' ? b['summary'].trim() : '';
  if (!summary) fields.push({ field: 'summary', message: 'Write a short summary of your judgement.' });
  else if (summary.length > SCORECARD_LIMITS.summaryChars) fields.push({ field: 'summary', message: `Keep the summary under ${SCORECARD_LIMITS.summaryChars} characters.` });

  const reasonRaw = b['reason'];
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;
  if (reasonRaw !== undefined && reasonRaw !== null && typeof reasonRaw !== 'string') fields.push({ field: 'reason', message: 'The reason must be text.' });
  if (reason && reason.length > SCORECARD_LIMITS.reasonChars) fields.push({ field: 'reason', message: `Keep the reason under ${SCORECARD_LIMITS.reasonChars} characters.` });
  if (reason && basedOn === 0) fields.push({ field: 'reason', message: 'A reason is only for correcting a scorecard you already submitted.' });

  if (fields.length) return { ok: false, fields };
  // In the kit's order, whatever order they came in.
  const order = new Map(competencies.map((c, n) => [c.id, n]));
  ratings.sort((x, y) => order.get(x.competencyId)! - order.get(y.competencyId)!);
  return { ok: true, value: { ratings, recommendation: recommendation as Recommendation, summary, reason, basedOn: basedOn as number } };
}

/**
 * Whether a rating changed after the recap was opened (decision 14). `ratingsAtRecap` is what round 5 records when
 * the recap is first opened (RECAP STEP above); null means it was never opened, so nothing changed after it.
 */
export function changedAfterRecap(ratingsAtRecap: readonly Pick<CompetencyRating, 'competencyId' | 'rating'>[] | null, ratings: readonly CompetencyRating[]): boolean {
  if (!ratingsAtRecap) return false;
  const before = new Map(ratingsAtRecap.map((r) => [r.competencyId, r.rating]));
  return ratings.some((r) => before.get(r.competencyId) !== r.rating);
}

/** The row to insert: the route gives the id and the time; the author is always the signed-in person. */
export function newScorecardVersion(args: {
  id: string; interviewId: string; authorId: string; version: number; input: ScorecardInput; reason: string | null; at: string; ratingsAtRecap: readonly Pick<CompetencyRating, 'competencyId' | 'rating'>[] | null;
}): Scorecard {
  return {
    id: args.id,
    interviewId: args.interviewId,
    interviewerId: args.authorId,
    ratings: args.input.ratings.map((r) => ({ ...r })),
    recommendation: args.input.recommendation,
    summary: args.input.summary,
    submittedAt: args.at,
    version: args.version,
    changedAfterRecap: changedAfterRecap(args.ratingsAtRecap, args.input.ratings),
    correctionReason: args.version > 1 ? args.reason : null,
  };
}

/** Everyone seated on the interview: the lead, then the panel. */
export const seatedOf = (i: Pick<Interview, 'leadId' | 'panelIds'>): string[] => [i.leadId, ...i.panelIds];

/** Should the interview move to `scored` now? Only from `ended`, once every seated person's scorecard is in. */
export function isScoredNow(i: Pick<Interview, 'id' | 'leadId' | 'panelIds' | 'state'>, cards: readonly Scorecard[]): boolean {
  if (i.state !== 'ended') return false;
  const authors = new Set(cards.filter((s) => s.interviewId === i.id).map((s) => s.interviewerId));
  return seatedOf(i).every((p) => authors.has(p));
}

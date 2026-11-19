// The scorecard on the portal side (docs/interviews-tenant-plan.md row I5.3; contract D8): what the page reads
// (GET /api/interviews/interviews/:id/scorecard), the one write (POST …/scorecard) and the pure model of the form.
// The server decides everything (middleware lib/interviews/scorecard.ts); this only says what the form still lacks
// before Submit, so the person is told before they are refused.
//
// The draft (what is typed before Submit) is kept in this browser only, per interview, and cleared on submit. It is
// never sent anywhere until Submit.

import { clockOf } from './interviewsRecord.ts';
import { INTERVIEWS_API, RECOMMENDATION_LABELS, type InterviewState, type Recommendation, type RoundType } from './interviews.ts';
import type { KitCompetency } from './interviewsKit.ts';
import { seenFlagsOf, type KitRedFlag } from './interviewsAnswerKey.ts';
import type { MiloAskBody } from './interviewsRoom.ts';
import { writeJson } from './writeJson.ts';

export type Rating = 1 | 2 | 3 | 4;
export interface CompetencyRating { competencyId: string; rating: Rating; note: string }
export interface PersonRef { id: string; name: string }

export interface ScorecardVersion {
  id: string;
  interviewer: PersonRef;
  recommendation: Recommendation;
  summary: string;
  submittedAt: string;
  version: number;
  correctionReason: string | null;
  /** A board round: the red flags the author ticked (absent when none). Never scored, and not in Milo's recommendation. */
  redFlagsSeen?: string[];
  /** Each rating with its competency's name and the anchor sentence for the rating given, as rated (whatever the round assesses now). */
  ratings: Array<CompetencyRating & { competency: string; anchor?: string | null }>;
}
export interface ScorecardView extends ScorecardVersion { earlier: ScorecardVersion[] }
export type OtherScorecard = ScorecardView & { interviewId: string; round: string };

/** D8: GET /api/interviews/interviews/:id/scorecard. */
export interface ScorecardPageView {
  interview: {
    id: string; state: InterviewState; endedAt: string | null; revision: number;
    round: { id: string; name: string; type: RoundType; minutes: number };
    candidate: { id: string; name: string };
    opening: { id: string; title: string };
    seat: 'lead' | 'panel' | null;
    /** Who leads the round: their scorecard is the one Milo's recommendation waits for. */
    leadId: string;
  };
  competencies: KitCompetency[];
  /** The competencies the round assesses: each must be rated. `competencies` adds only what the viewer's own latest version rated outside them (optional, kept on a correction). */
  required: string[];
  /** A board round's red flags by group (its questions' answer key), the "Red flags seen" checklist; empty otherwise (missing from an older server). */
  redFlags?: KitRedFlag[];
  mine: ScorecardView | null;
  canSubmit: boolean;
  refusal: string | null;
  othersHidden: boolean;
  others: OtherScorecard[];
  limits: { noteChars: number; summaryChars: number; reasonChars: number };
}

export const scorecardPath = (id: string): string => `/interviews/rounds/${encodeURIComponent(id)}/scorecard`;

/** A row on My interviews opens the scorecard once the round has ended and the viewer holds a seat on it. */
export const hasScorecard = (row: { seat: 'lead' | 'panel' | null; state: InterviewState }): boolean =>
  row.seat !== null && (row.state === 'ended' || row.state === 'scored' || row.state === 'reviewed');

export const RECOMMENDATION_CHOICES: ReadonlyArray<{ value: Recommendation; label: string }> = [
  { value: 'strong-no', label: 'Strong no' }, { value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }, { value: 'strong-yes', label: 'Strong yes' },
];

/**
 * The form's steps, in order (decision 14): rate from your own judgement, then Milo's recap, then the go or no-go.
 * Continuing to the recap records the ratings as they stand, on the server (POST …/recap/open); the server compares the
 * submitted ratings against that record, so going back to change a rating is allowed and shows on the scorecard.
 */
export const SCORECARD_STEPS = ['rate', 'recap', 'decide'] as const;
export type ScorecardStep = typeof SCORECARD_STEPS[number];

export const nextStep = (s: ScorecardStep): ScorecardStep => SCORECARD_STEPS[Math.min(SCORECARD_STEPS.indexOf(s) + 1, SCORECARD_STEPS.length - 1)]!;
export const previousStep = (s: ScorecardStep): ScorecardStep => SCORECARD_STEPS[Math.max(SCORECARD_STEPS.indexOf(s) - 1, 0)]!;

/** What the form holds before Submit. */
export interface Draft {
  ratings: Record<string, Rating | null>;
  notes: Record<string, string>;
  recommendation: Recommendation | null;
  summary: string;
  /** Only when correcting a submitted scorecard. */
  reason: string;
  /** Where the person is in the form. */
  step: ScorecardStep;
  /** A board round: the red flags ticked so far, by their text. */
  redFlagsSeen?: string[];
  /** The recap was opened from this draft: going back to it asks nothing again (the server keeps the first open only). */
  recapOpened: boolean;
}

export const emptyDraft = (): Draft => ({ ratings: {}, notes: {}, recommendation: null, summary: '', reason: '', step: 'rate', recapOpened: false });

/** A correction starts from the latest version as submitted, back at the ratings. */
export function draftFrom(card: ScorecardView): Draft {
  return {
    ratings: Object.fromEntries(card.ratings.map((r) => [r.competencyId, r.rating])),
    notes: Object.fromEntries(card.ratings.map((r) => [r.competencyId, r.note])),
    recommendation: card.recommendation, summary: card.summary, reason: '', step: 'rate', recapOpened: false,
    ...(card.redFlagsSeen?.length ? { redFlagsSeen: [...card.redFlagsSeen] } : {}),
  };
}

/** Every competency the round requires rated: what "Continue to the recap" needs. Pass the required ones only. */
export const allRated = (d: Pick<Draft, 'ratings'>, required: readonly KitCompetency[]): boolean => required.every((c) => !!d.ratings[c.id]);

/** The round's competencies first (each required), then any the viewer's own earlier version rated outside them (optional), each group in the kit's order. */
export function roundCompetencies(view: Pick<ScorecardPageView, 'competencies' | 'required'>): { required: KitCompetency[]; optional: KitCompetency[] } {
  const need = new Set(view.required ?? view.competencies.map((c) => c.id));
  return { required: view.competencies.filter((c) => need.has(c.id)), optional: view.competencies.filter((c) => !need.has(c.id)) };
}

/** The scale's labels for one competency: its anchors, lowest first. */
export const scaleOf = (c: KitCompetency): Array<{ value: number; label: string }> => ([1, 2, 3, 4] as const).map((n) => ({ value: n, label: c.anchors[n] }));

/** The recommendation as a go or no-go in words: "Go, strong yes", "No-go, no". */
export const recommendationVerdict = (r: Recommendation): string => `${r === 'yes' || r === 'strong-yes' ? 'Go' : 'No-go'}, ${RECOMMENDATION_LABELS[r].toLowerCase()}`;

/** Decision 14's three steps in the order a scorecard is filled; a submitted scorecard has been through all of them. */
export const SCORECARD_STEP_LABELS: Readonly<Record<ScorecardStep, string>> = { rate: 'Rate each competency', recap: "Read Milo's recap", decide: 'Recommend' };

/** What still stands between the draft and Submit, one plain sentence each, in the form's order. Empty when complete. */
export function missingFrom(d: Draft, competencies: readonly KitCompetency[], limits: ScorecardPageView['limits'], correcting: boolean, required: readonly KitCompetency[] = competencies): string[] {
  const out: string[] = [];
  const unrated = required.filter((c) => !d.ratings[c.id]);
  if (unrated.length) out.push(`Rate ${unrated.map((c) => c.name).join(', ')}.`);
  for (const c of competencies) if ((d.notes[c.id] ?? '').trim().length > limits.noteChars) out.push(`Keep the note on ${c.name} under ${limits.noteChars} characters.`);
  if (!d.recommendation) out.push('Choose your recommendation.');
  if (!d.summary.trim()) out.push('Write a short summary of your judgement.');
  else if (d.summary.trim().length > limits.summaryChars) out.push(`Keep the summary under ${limits.summaryChars} characters.`);
  if (correcting && !d.reason.trim()) out.push('Say why you are correcting your scorecard.');
  if (correcting && d.reason.trim().length > limits.reasonChars) out.push(`Keep the reason under ${limits.reasonChars} characters.`);
  return out;
}

/** The body POST …/scorecard takes. There is no author in it: the server always uses the signed-in person. Only the red
 *  flags the round's kit still lists (`redFlags`) go: one reworded or removed since the draft began would be refused. */
export function bodyOf(d: Draft, competencies: readonly KitCompetency[], basedOn: number, redFlags: readonly string[]): Record<string, unknown> {
  const redFlagsSeen = seenFlagsOf(d.redFlagsSeen, redFlags);
  return {
    // Only what was rated: an optional competency left "Not seen in this round" is not sent.
    ratings: competencies.filter((c) => !!d.ratings[c.id]).map((c) => ({ competencyId: c.id, rating: d.ratings[c.id], note: (d.notes[c.id] ?? '').trim() })),
    recommendation: d.recommendation, summary: d.summary.trim(), basedOn,
    ...(redFlagsSeen.length ? { redFlagsSeen } : {}),
    ...(basedOn > 0 ? { reason: d.reason.trim() } : {}),
  };
}

/**
 * What the viewer reads of the others' scorecards, as one line when they read none: hidden until their own is in,
 * or nobody else's yet. Null when there are some to show.
 */
export function othersLine(view: Pick<ScorecardPageView, 'othersHidden' | 'others' | 'interview'>): string | null {
  if (view.othersHidden) return 'The other interviewers\' scorecards for this candidate stay hidden until yours is in.';
  if (view.others.length === 0) return view.interview.seat ? 'No one else has submitted a scorecard for this candidate yet.' : 'No scorecards have been submitted for this candidate yet.';
  return null;
}

// ── the draft, in this browser only ─────────────────────────────────────────

export interface DraftStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
const draftKey = (interviewId: string, basedOn: number) => `interviews:scorecard-draft:${interviewId}:${basedOn}`;
const browser = (): DraftStore | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

export function loadDraft(interviewId: string, basedOn: number, store: DraftStore | null = browser()): Draft | null {
  try {
    const raw = store?.getItem(draftKey(interviewId, basedOn));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    const opened = d.recapOpened === true;
    // A step past the ratings is only resumed when the recap was opened from this draft.
    const step = opened && (SCORECARD_STEPS as readonly string[]).includes(d.step ?? '') ? d.step! : 'rate';
    return { ...emptyDraft(), ...d, step, recapOpened: opened, ratings: { ...(d.ratings ?? {}) }, notes: { ...(d.notes ?? {}) } };
  } catch { return null; }
}

export function saveDraft(interviewId: string, basedOn: number, d: Draft, store: DraftStore | null = browser()): void {
  try { store?.setItem(draftKey(interviewId, basedOn), JSON.stringify(d)); } catch { /* the draft is a convenience */ }
}

export function clearDraft(interviewId: string, basedOn: number, store: DraftStore | null = browser()): void {
  try { store?.removeItem(draftKey(interviewId, basedOn)); } catch { /* the draft is a convenience */ }
}

// ── the write ───────────────────────────────────────────────────────────────

export type SubmitOutcome = { ok: true; view: ScorecardPageView | null } | { ok: false; error: string; stale: boolean; view: ScorecardPageView | null };

export async function submitScorecard(interviewId: string, body: Record<string, unknown>): Promise<SubmitOutcome> {
  const r = await writeJson<{ scorecard?: ScorecardPageView | null; fields?: Array<{ message: string }> }>(
    `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/scorecard`, 'POST', body);
  if (r.ok) return { ok: true, view: r.data?.scorecard ?? null };
  return { ok: false, error: r.data?.fields?.[0]?.message ?? r.error ?? 'Your scorecard could not be submitted. Try again.', stale: r.status === 409, view: r.data?.scorecard ?? null };
}

// ── Milo's recap (row I5.2, contract E3) ────────────────────────────────────

export interface RecapClaim { text: string; source: { kind: 'transcript'; seq: number; quote: string } }
/** E3: what POST …/recap/open and GET …/recap answer. Milo's evidence carries no rating, tone or score. */
export interface RecapBody {
  state: 'ready' | 'none' | 'no-transcript' | 'paused';
  paused: null | 'budget';
  writtenAt: string | null;
  competencies: Array<{ id: string; name: string; evidence: RecapClaim[] }>;
  notCovered: Array<{ id: string; name: string }>;
}

export const recapUrl = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/recap`;

/** What "Continue to the recap" posts: the ratings as they stand, nothing else (no notes, no recommendation). */
export function openBodyOf(d: Pick<Draft, 'ratings'>, competencies: readonly KitCompetency[]): { ratings: Array<{ competencyId: string; rating: Rating }> } {
  return { ratings: competencies.filter((c) => !!d.ratings[c.id]).map((c) => ({ competencyId: c.id, rating: d.ratings[c.id]! })) };
}

/** Why a seat's submitted scorecard has no "Correct it": the round was reviewed. Null otherwise. */
export function reviewedLine(state: InterviewState, hasMine: boolean): string | null {
  return state === 'reviewed' && hasMine ? 'This round has been reviewed, so its scorecards can no longer be corrected.' : null;
}

/** One sentence for a recap that has nothing to show; null when it is ready. */
export function recapStateLine(r: Pick<RecapBody, 'state'>, forReaders = false): string | null {
  // Neutral on purpose: it must not tell the panel which of the candidate's answers left the round without a transcript.
  if (r.state === 'no-transcript') return 'Milo has no recap for this round.';
  if (r.state === 'paused') return 'Milo could not write the recap because this opening\'s interview budget is used up. Your scorecard does not need it.';
  if (r.state === 'none') return forReaders ? 'Milo has no recap for this interview yet.' : 'Milo could not write a recap for this interview. Your scorecard does not need it.';
  return null;
}

/** Milo's evidence for one competency, and whether anything was said about it. */
export function evidenceFor(r: Pick<RecapBody, 'competencies'>, competencyId: string): RecapClaim[] {
  return r.competencies.find((c) => c.id === competencyId)?.evidence ?? [];
}

export type OpenRecapOutcome = { ok: true; recap: RecapBody } | { ok: false; error: string };

export async function openRecap(interviewId: string, body: ReturnType<typeof openBodyOf>): Promise<OpenRecapOutcome> {
  const r = await writeJson<{ recap?: RecapBody }>(`${recapUrl(interviewId)}/open`, 'POST', body);
  if (r.ok && r.data?.recap) return { ok: true, recap: r.data.recap };
  return { ok: false, error: r.error ?? 'Milo\'s recap could not be opened. Try again.' };
}

// ── Ask Milo where something was said, from the recap (contract F1) ─────────────────────────────────────────────────

export const recapAskPath = (interviewId: string): string => `${recapUrl(interviewId)}/ask`;
export const RECAP_ASK_FALLBACK = 'That did not go through. Try again.';

/** The server's answer as the step shows it: an answer, a refusal or a pause is a body with a line; anything else is one error line. */
export function recapAskOutcome(r: { ok: boolean; status: number; data?: MiloAskBody | null; error?: string | null }): { ok: true; body: MiloAskBody } | { ok: false; error: string } {
  if (r.data && (r.ok || (r.status === 409 && typeof r.data.line === 'string'))) return { ok: true, body: r.data };
  return { ok: false, error: r.error ?? RECAP_ASK_FALLBACK };
}

export async function askFromRecap(interviewId: string, question: string): Promise<ReturnType<typeof recapAskOutcome>> {
  return recapAskOutcome(await writeJson<MiloAskBody>(recapAskPath(interviewId), 'POST', { question }));
}

/**
 * Where a recap answer's source sits (E4 #38): "Line 2, Mateo Álvarez" and the record's own clock for it ("0:07", ms from the
 * record's start, as the record shows its lines), or null when the server sent no offset (an older server).
 */
export function recapSourceOf(s: { seq: number; speaker: string; offsetMs?: number }): { label: string; clock: string | null; seconds: number | null } {
  const at = typeof s.offsetMs === 'number' && Number.isFinite(s.offsetMs) ? Math.max(0, s.offsetMs) : null;
  return { label: `Line ${s.seq}${s.speaker ? `, ${s.speaker}` : ''}`, clock: at === null ? null : clockOf(at), seconds: at === null ? null : Math.floor(at / 1000) };
}

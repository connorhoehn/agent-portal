// The scorecard on the portal side (docs/interviews-tenant-plan.md row I5.3; contract D8): what the page reads
// (GET /api/interviews/interviews/:id/scorecard), the one write (POST …/scorecard) and the pure model of the form.
// The server decides everything (middleware lib/interviews/scorecard.ts); this only says what the form still lacks
// before Submit, so the person is told before they are refused.
//
// The draft (what is typed before Submit) is kept in this browser only, per interview, and cleared on submit. It is
// never sent anywhere until Submit.

import { INTERVIEWS_API, type InterviewState, type Recommendation, type RoundType } from './interviews.ts';
import type { KitCompetency } from './interviewsKit.ts';
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
  ratings: Array<CompetencyRating & { competency: string }>;
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
  };
  competencies: KitCompetency[];
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
 * The form's steps, in order. RECAP STEP (row I5.2, round 5): Milo's recap goes between 'rate' and 'decide'; opening
 * it records the ratings as they stand (`Draft.ratingsAtRecap`), which the submit then carries.
 */
export const SCORECARD_STEPS = ['rate', 'decide'] as const;

/** What the form holds before Submit. */
export interface Draft {
  ratings: Record<string, Rating | null>;
  notes: Record<string, string>;
  recommendation: Recommendation | null;
  summary: string;
  /** Only when correcting a submitted scorecard. */
  reason: string;
}

export const emptyDraft = (): Draft => ({ ratings: {}, notes: {}, recommendation: null, summary: '', reason: '' });

/** A correction starts from the latest version as submitted. */
export function draftFrom(card: ScorecardView): Draft {
  return {
    ratings: Object.fromEntries(card.ratings.map((r) => [r.competencyId, r.rating])),
    notes: Object.fromEntries(card.ratings.map((r) => [r.competencyId, r.note])),
    recommendation: card.recommendation, summary: card.summary, reason: '',
  };
}

/** The scale's labels for one competency: its anchors, lowest first. */
export const scaleOf = (c: KitCompetency): Array<{ value: number; label: string }> => ([1, 2, 3, 4] as const).map((n) => ({ value: n, label: c.anchors[n] }));

/** What still stands between the draft and Submit, one plain sentence each, in the form's order. Empty when complete. */
export function missingFrom(d: Draft, competencies: readonly KitCompetency[], limits: ScorecardPageView['limits'], correcting: boolean): string[] {
  const out: string[] = [];
  const unrated = competencies.filter((c) => !d.ratings[c.id]);
  if (unrated.length) out.push(`Rate ${unrated.map((c) => c.name).join(', ')}.`);
  for (const c of competencies) if ((d.notes[c.id] ?? '').trim().length > limits.noteChars) out.push(`Keep the note on ${c.name} under ${limits.noteChars} characters.`);
  if (!d.recommendation) out.push('Choose your recommendation.');
  if (!d.summary.trim()) out.push('Write a short summary of your judgement.');
  else if (d.summary.trim().length > limits.summaryChars) out.push(`Keep the summary under ${limits.summaryChars} characters.`);
  if (correcting && !d.reason.trim()) out.push('Say why you are correcting your scorecard.');
  if (correcting && d.reason.trim().length > limits.reasonChars) out.push(`Keep the reason under ${limits.reasonChars} characters.`);
  return out;
}

/** The body POST …/scorecard takes. There is no author in it: the server always uses the signed-in person. */
export function bodyOf(d: Draft, competencies: readonly KitCompetency[], basedOn: number): Record<string, unknown> {
  return {
    ratings: competencies.map((c) => ({ competencyId: c.id, rating: d.ratings[c.id], note: (d.notes[c.id] ?? '').trim() })),
    recommendation: d.recommendation, summary: d.summary.trim(), basedOn,
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
    return { ...emptyDraft(), ...d, ratings: { ...(d.ratings ?? {}) }, notes: { ...(d.notes ?? {}) } };
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

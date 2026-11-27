// The debrief on the portal side (docs/interviews-tenant-plan.md decisions 6, 14, 15; rows I5.4, I5.5; contract E4): what
// the page reads (GET /api/interviews/candidates/:id/debrief), the hiring manager's one write (POST
// /api/interviews/applications/:id/stage), and the pure model of the side-by-side table. The server decides who reads
// and who decides (middleware lib/interviews/debrief/); this only lays out what people wrote, next to each other, and
// never adds anything of its own: no average, no total, no order of who scored higher (decision 6).
//
// The recap (contract E3) is read in place from the round's `recapPath`; its shape is RECAP's and is mirrored here.

import { INTERVIEWS_API, type ApplicationStage, type InterviewState, type PersonRef, type Recommendation, type RoundType } from './interviews.ts';
import { plural } from './plural.ts';
import { writeJson } from './writeJson.ts';

export type Decision = 'advance' | 'hold' | 'reject';
export type Rating = 1 | 2 | 3 | 4;
export type Anchors = Record<Rating, string>;

export interface DebriefScorecard {
  id: string;
  interviewer: PersonRef;
  version: number;
  submittedAt: string;
  recommendation: Recommendation;
  summary: string;
  ratings: Array<{ competencyId: string; competency: string; rating: Rating; note: string }>;
  changedAfterRecap: boolean;
  correctionReason: string | null;
  earlierVersions: number;
}

export interface DebriefRound {
  interviewId: string;
  name: string;
  type: RoundType;
  minutes: number;
  state: InterviewState;
  lead: PersonRef;
  panel: PersonRef[];
  scheduledAt: string | null;
  endedAt: string | null;
  scorecards: DebriefScorecard[];
  due: PersonRef[];
  recapPath: string | null;
  recordPath: string | null;
}

export interface DebriefMove {
  stage: ApplicationStage;
  at: string;
  by: string | null;
  byName: string | null;
  reason: string | null;
  decision: Decision | null;
  scorecardsMissing: number | null;
}

export interface DebriefDecide {
  options: Array<{ decision: Decision; to: ApplicationStage; allowed: boolean; refusal: string | null }>;
  scorecardsMissing: number;
  limits: { reasonMin: number; reasonMax: number };
}

export interface DebriefApplication {
  applicationId: string;
  opening: { id: string; title: string; team: string };
  stage: ApplicationStage;
  history: DebriefMove[];
  basedOn: number;
  competencies: Array<{ id: string; name: string; anchors: Anchors }>;
  rounds: DebriefRound[];
  decide: DebriefDecide | null;
  /** Why there is no decision control, and who can change that (middleware debrief/view.ts); null exactly when `decide` is set. */
  noDecision?: { reason: 'no-hiring-manager' | 'not-the-hiring-manager'; message: string } | null;
}

export interface DebriefView {
  candidate: { id: string; name: string; headline: string };
  applications: DebriefApplication[];
}

/** E3, as RECAP serves it. */
export interface RecapBody {
  state: 'ready' | 'none' | 'no-transcript' | 'paused';
  paused: null | 'budget';
  writtenAt: string | null;
  competencies: Array<{ id: string; name: string; evidence: Array<{ text: string; source: { kind: 'transcript'; seq: number; quote: string } }> }>;
  notCovered: Array<{ id: string; name: string }>;
}

export const debriefHref = (candidateId: string): string => `/interviews/candidates/${encodeURIComponent(candidateId)}/debrief`;
export const debriefApi = (candidateId: string): string => `${INTERVIEWS_API}/candidates/${encodeURIComponent(candidateId)}/debrief`;

/** Who opens a debrief: the recruiter, the hiring manager and the admin. An interviewer is never sent there. */
export const readsDebrief = (role: string | undefined): boolean => role === 'recruiter' || role === 'hiring-manager' || role === 'admin';

// ── words ────────────────────────────────────────────────────────────────────

/** The three choices as the hiring manager reads them. */
export const DECISION_CHOICES: Readonly<Record<Decision, string>> = {
  advance: 'Advance to an offer', hold: 'Put on hold', reject: 'Do not move forward',
};

/** A recorded decision in the history. */
export const DECISION_DONE: Readonly<Record<Decision, string>> = { advance: 'Advanced', hold: 'Put on hold', reject: 'Not moving forward' };

export const decisionTone = (d: Decision): 'success' | 'caution' | 'neutral' => (d === 'advance' ? 'success' : d === 'hold' ? 'caution' : 'neutral');

/** "2 scorecards were still due", or null when none were. */
export function missingLine(n: number | null, tense: 'now' | 'then' = 'then'): string | null {
  if (!n) return null;
  return `${plural(n, 'scorecard')} ${tense === 'now' ? (n === 1 ? 'is' : 'are') : (n === 1 ? 'was' : 'were')} still due`;
}

/** One line under a round with nothing to read side by side yet. */
export function roundEmptyLine(r: Pick<DebriefRound, 'state' | 'due' | 'scorecards'>): string | null {
  if (r.scorecards.length) return null;
  if (r.state === 'declined' || r.state === 'cancelled') return 'This round did not go ahead.';
  if (!r.due.length) return 'This round has not been held yet.';
  return `Nothing is in yet. Due from ${r.due.map((p) => p.name).join(' and ')}.`;
}

/** Who still owes a scorecard on a round where others are in. */
export function dueLine(r: Pick<DebriefRound, 'due' | 'scorecards'>): string | null {
  return r.scorecards.length && r.due.length ? `Still due from ${r.due.map((p) => p.name).join(' and ')}.` : null;
}

/** What a reader should know about one scorecard beyond its ratings: a recap change, a correction, earlier versions. */
export function scorecardNotes(s: DebriefScorecard): string[] {
  const out: string[] = [];
  if (s.changedAfterRecap) out.push(`${s.interviewer.name} changed a rating after reading Milo's recap.`);
  if (s.correctionReason) out.push(`${s.interviewer.name} corrected this in version ${s.version}: ${s.correctionReason}`);
  if (s.earlierVersions) out.push(`${plural(s.earlierVersions, 'earlier version')} of ${s.interviewer.name}'s scorecard ${s.earlierVersions === 1 ? 'is' : 'are'} kept on the scorecard page.`);
  return out;
}

/** The recap's state in one sentence, or null when there is evidence to show. */
export function recapLine(r: RecapBody): string | null {
  switch (r.state) {
    case 'ready': return r.competencies.some((c) => c.evidence.length) ? null : 'Milo found nothing to quote for these competencies.';
    case 'none': return 'Milo\'s recap has not been written for this round yet.';
    case 'no-transcript': return 'This round ran without a transcript, so Milo wrote no recap.';
    case 'paused': return 'Milo\'s recap is paused because this opening\'s budget is spent.';
  }
}

// ── the side-by-side table ──────────────────────────────────────────────────

export interface SideColumn { id: string; interviewer: PersonRef; version: number }

export type SideCell =
  | { kind: 'rating'; rating: Rating; anchor: string; note: string }
  | { kind: 'recommendation'; recommendation: Recommendation }
  | { kind: 'summary'; text: string }
  | { kind: 'none' };

export interface SideRow { id: string; label: string; cells: Record<string, SideCell> }

/**
 * One row per competency in the kit's order, one column per scorecard in seat order, then the recommendation and the
 * summary. A competency a scorecard has no rating for is an empty cell, never a guess. Nothing is summed or ordered by
 * how high anyone scored.
 */
export function sideBySide(round: Pick<DebriefRound, 'scorecards'>, competencies: DebriefApplication['competencies']): { columns: SideColumn[]; rows: SideRow[] } {
  const columns = round.scorecards.map((s) => ({ id: s.id, interviewer: s.interviewer, version: s.version }));
  const rows: SideRow[] = competencies.map((c) => ({
    id: `competency:${c.id}`, label: c.name,
    cells: Object.fromEntries(round.scorecards.map((s) => {
      const r = s.ratings.find((x) => x.competencyId === c.id);
      return [s.id, r ? { kind: 'rating', rating: r.rating, anchor: c.anchors[r.rating] ?? '', note: r.note } : { kind: 'none' }] as const;
    })),
  }));
  rows.push({ id: 'recommendation', label: 'Recommendation', cells: Object.fromEntries(round.scorecards.map((s) => [s.id, { kind: 'recommendation', recommendation: s.recommendation }] as const)) });
  rows.push({ id: 'summary', label: 'Summary', cells: Object.fromEntries(round.scorecards.map((s) => [s.id, { kind: 'summary', text: s.summary }] as const)) });
  return { columns, rows };
}

export interface AppColumn extends SideColumn { roundId: string; roundName: string; firstInRound: boolean }

/**
 * One table for an application (decision 15): the competencies down the side, then across each round as a group with one
 * column per scorecard in seat order, then the recommendation and the summary. A round with no scorecard has no column
 * (the page says why under the table). Same cells as `sideBySide`; nothing is summed or ordered by how high anyone scored.
 */
export function applicationSideBySide(rounds: Array<Pick<DebriefRound, 'interviewId' | 'name' | 'scorecards'>>, competencies: DebriefApplication['competencies']): { columns: AppColumn[]; rows: SideRow[] } {
  const columns: AppColumn[] = [];
  let rows: SideRow[] = [];
  for (const r of rounds) {
    const part = sideBySide(r, competencies);
    part.columns.forEach((c, i) => columns.push({ ...c, roundId: r.interviewId, roundName: r.name, firstInRound: i === 0 }));
    rows = part.rows.map((row, i) => ({ ...row, cells: { ...(rows[i]?.cells ?? {}), ...row.cells } }));
  }
  if (!rows.length) rows = sideBySide({ scorecards: [] }, competencies).rows;
  return { columns, rows };
}

// ── the decision ────────────────────────────────────────────────────────────

/** The confirmation: what is recorded, under whose name, and once more if a scorecard is still due. */
export function confirmQuestion(decide: Pick<DebriefDecide, 'scorecardsMissing'>, decision: Decision, who: string): string {
  const missing = missingLine(decide.scorecardsMissing, 'now');
  return [
    missing ? `${missing}. You can decide now; the debrief will show it was decided without them.` : null,
    `Record "${DECISION_CHOICES[decision]}" under your name, ${who}? It cannot be edited; a later decision is a new entry.`,
  ].filter(Boolean).join(' ');
}

/** What the reason prompt refuses before the server does. */
export function reasonProblem(text: string, limits: DebriefDecide['limits']): string | null {
  const t = text.trim();
  if (t.length < limits.reasonMin) return 'Say why in a sentence. Your reason is recorded with the decision.';
  if (t.length > limits.reasonMax) return `Keep the reason under ${limits.reasonMax} characters.`;
  return null;
}

export type DecideOutcome = { ok: true; view: DebriefView | null } | { ok: false; error: string; stale: boolean; view: DebriefView | null };

export async function decideStage(applicationId: string, body: { decision: Decision; reason: string; basedOn: number }): Promise<DecideOutcome> {
  const r = await writeJson<{ debrief?: DebriefView | null; fields?: Array<{ message: string }> }>(
    `${INTERVIEWS_API}/applications/${encodeURIComponent(applicationId)}/stage`, 'POST', body);
  if (r.ok) return { ok: true, view: r.data?.debrief ?? null };
  return { ok: false, error: r.data?.fields?.[0]?.message ?? r.error ?? 'The decision could not be recorded. Try again.', stale: r.status === 409, view: r.data?.debrief ?? null };
}

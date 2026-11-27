// Preparing a round on the portal side (docs/interviews-tenant-plan.md row I1.7; contract C6): the record the Prepare
// page reads (GET /api/interviews/interviews/:id), the one write (PUT …/questions) and the pure helpers around the plan.
// The server checks everything (middleware lib/interviews/prepare.ts) and answers each problem as one sentence.

import { INTERVIEWS_API, type InterviewRow } from './interviews.ts';
import type { KitCompetency } from './interviewsKit.ts';
import { writeJson } from './writeJson.ts';

export interface BankQuestion { id: string; prompt: string; competencyId: string; competency: string; hasStarter: boolean }

/** GET /api/interviews/interviews/:id: the row plus what the Prepare page needs. */
export interface InterviewRecord extends InterviewRow {
  questionsChosen: Array<{ id: string; prompt: string; competencyId: string }>;
  competencies: KitCompetency[];
  bank: BankQuestion[];
  canPrepare: boolean;
  missing: string | null;
  maxQuestions: number;
  /** Whether the opening has a spending cap; without one Run and Milo are refused in the room, so the page warns. */
  spendingCapSet?: boolean;
}

export const preparePath = (id: string): string => `/interviews/rounds/${encodeURIComponent(id)}/prepare`;
export const roomPath = (id: string): string => `/interviews/rounds/${encodeURIComponent(id)}/room`;

/** The lead sees "Open the room" once the round is ready or live; a panel member too (they hold a seat). */
export const canOpenRoom = (row: Pick<InterviewRow, 'state' | 'seat'>): boolean => row.seat !== null && (row.state === 'ready' || row.state === 'live');

export type PlanOutcome = { ok: true; interview: InterviewRecord | null } | { ok: false; error: string; stale: boolean; interview: InterviewRecord | null };

export async function savePlan(id: string, revision: number, questionIds: string[]): Promise<PlanOutcome> {
  const r = await writeJson<{ interview?: InterviewRecord | null; fields?: Array<{ message: string }> }>(
    `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/questions`, 'PUT', { revision, questionIds });
  if (r.ok) return { ok: true, interview: r.data?.interview ?? null };
  const detail = r.data?.fields?.[0]?.message;
  return { ok: false, error: detail ?? r.error ?? 'The plan could not be saved. Try again.', stale: r.status === 409, interview: r.data?.interview ?? null };
}

/** The bank grouped by competency in the order the competencies come, each group in bank order; questions already in the plan left out. */
export function bankGroups(bank: readonly BankQuestion[], competencies: ReadonlyArray<{ id: string }>, plan: readonly string[]): Array<{ competencyId: string; name: string; questions: BankQuestion[] }> {
  const rank = new Map(competencies.map((c, i) => [c.id, i]));
  const groups = new Map<string, { competencyId: string; name: string; questions: BankQuestion[] }>();
  for (const q of bank) {
    if (plan.includes(q.id)) continue;
    const g = groups.get(q.competencyId) ?? { competencyId: q.competencyId, name: q.competency, questions: [] };
    g.questions.push(q);
    groups.set(q.competencyId, g);
  }
  return [...groups.values()].sort((a, b) => (rank.get(a.competencyId) ?? 99) - (rank.get(b.competencyId) ?? 99));
}

export const samePlan = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- Milo's suggested plan (row I3.10; contract E6) ------------------------------------------------------------------------------

export interface DraftQuestion { questionId: string; why: string }
/** POST …/plan-draft: advisory; nothing is saved by it. `line` is the one plain sentence when there is no plan. */
export interface PlanDraft { plan: { questions: DraftQuestion[] } | null; paused: null | 'budget'; line: string | null }
export type DraftOutcome = { ok: true; draft: PlanDraft } | { ok: false; error: string };

export const BUDGET_PAUSED_LINE = 'Milo is paused for this opening until its budget is raised, so no plan can be drafted. You can still choose the questions yourself.';
export const NO_PLAN_LINE = 'Milo could not draft a plan this time. Choose the questions yourself below.';

export async function askForPlan(id: string): Promise<DraftOutcome> {
  const r = await writeJson<PlanDraft>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/plan-draft`, 'POST', {});
  if (!r.ok) return { ok: false, error: r.data?.line ?? r.error ?? 'Milo could not be asked just now. Try again.' };
  return { ok: true, draft: { plan: r.data?.plan ?? null, paused: r.data?.paused ?? null, line: r.data?.line ?? null } };
}

/** The one plain line under the button for a draft with no plan; null when there is a plan. */
export function draftLine(d: PlanDraft): string | null {
  if (d.plan && d.plan.questions.length) return null;
  if (d.paused === 'budget') return BUDGET_PAUSED_LINE;
  return d.line ?? NO_PLAN_LINE;
}

/** What "Use this plan" puts in the page's own selection: the draft's questions that are still in the bank, in order, each once, at most `max`. */
export function planFromDraft(draft: readonly DraftQuestion[], bank: ReadonlyArray<{ id: string }>, max: number): string[] {
  const inBank = new Set(bank.map((q) => q.id));
  const out: string[] = [];
  for (const d of draft) if (inBank.has(d.questionId) && !out.includes(d.questionId) && out.length < max) out.push(d.questionId);
  return out;
}

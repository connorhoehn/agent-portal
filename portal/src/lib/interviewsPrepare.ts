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

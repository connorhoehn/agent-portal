// An opening's kit on the portal side (docs/interviews-tenant-plan.md, rows I1.3 and I1.8): the shapes
// GET /api/interviews/openings[/:id] answers, the editor's pure helpers, and the two writes. The server
// checks every kit (middleware lib/interviews/kit.ts) and answers each problem as one sentence on a path
// (`questions.2.prompt`); the editor shows it on that field. Ids are made here so a new question can
// probe a new competency before either is saved, and are never shown.

import { INTERVIEWS_API, type OpeningRow, type RoundType } from './interviews.ts';
import { writeJson } from './writeJson.ts';
import type { KitDesignQuestion, KitRedFlag } from './interviewsAnswerKey.ts';

export type PadLanguage = 'python' | 'swift' | 'javascript' | 'typescript' | 'java' | 'go' | 'cpp';
export const PAD_LANGUAGES: readonly PadLanguage[] = ['python', 'swift', 'javascript', 'typescript', 'java', 'go', 'cpp'];
export const PAD_LANGUAGE_LABELS: Readonly<Record<PadLanguage, string>> = {
  python: 'Python', swift: 'Swift', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java', go: 'Go', cpp: 'C++',
};
export type OpeningState = 'open' | 'paused' | 'closed';
export const OPENING_STATE_LABELS: Readonly<Record<OpeningState, string>> = { open: 'Open', paused: 'Paused', closed: 'Closed' };

/**
 * A round, with the competencies it assesses (ids, in the kit's order). The server names them for every round it
 * answers (a kit saved before rounds named theirs reads as all of them), so the editor always saves the list; a new
 * round starts with none and the server asks for at least one. A technical round names its surface (pad or board).
 */
export interface KitRound { id: string; name: string; type: RoundType; minutes: number; surface?: 'pad' | 'board'; competencyIds: string[] }
export interface KitCompetency { id: string; name: string; lookFor: string; anchors: { 1: string; 2: string; 3: string; 4: string } }
export interface KitQuestion {
  id: string;
  prompt: string;
  followUps: string[];
  competencyId: string;
  roundType: RoundType;
  starter?: Partial<Record<PadLanguage, string>>;
  /** A board round question's starting board (WHITEBOARD-PLAN step 2). */
  board?: { name: string; elements: Array<Record<string, unknown>> };
  /** A system design question's expected clarifying questions (the coach nudges the lead when none was asked). */
  clarifying?: string[];
  /** The answer key (lib/interviewsAnswerKey.ts): the interviewers' reference design, the design questions with answers, the red flags. Never the candidate's. */
  providedDesign?: { name: string; elements: Array<Record<string, unknown>> };
  designQuestions?: KitDesignQuestion[];
  redFlags?: KitRedFlag[];
}
export interface OpeningKit { rounds: KitRound[]; competencies: KitCompetency[]; questions: KitQuestion[] }

/** GET /openings: a row gains the kit at a glance. */
export interface OpeningListRow extends OpeningRow {
  kitSize: { competencies: number; questions: Record<RoundType, number> };
}
/** GET /openings/:id. */
export interface OpeningRecord extends OpeningListRow {
  competencies: KitCompetency[];
  questions: KitQuestion[];
  /** Sent only to the people who may read the opening's money (recruiter, its hiring manager, admin). */
  budgetCapUsd?: number | null;
  revision: number;
}

export interface OpeningDetails {
  title: string;
  level: string;
  team: string;
  location: string;
  hiringManagerId: string | null;
  state: OpeningState;
  /** The opening's spending cap across all its interviews; null = none set, and nothing that costs money starts (row I0.6). */
  budgetCapUsd: number | null;
  /** The cap per interview; null = the deployment's default. */
  interviewCapUsd: number | null;
}

/** GET /openings/:id/spend (row I0.6): the recruiter's, the hiring manager's and the admin's view of the opening's money. */
export interface OpeningMoney {
  capUsd: number | null;
  interviewCapUsd: number | null;
  defaultInterviewCapUsd: number;
  effectiveInterviewCapUsd: number;
  spentUsd: number;
  heldUsd: number;
  leftUsd: number | null;
  unknownCount: number;
}

/** Who reads an opening's money: never an interviewer (the server answers them not-found). */
export const readsOpeningMoney = (role: string | null | undefined): boolean => role === 'recruiter' || role === 'hiring-manager' || role === 'admin';

export const openingMoneyPath = (openingId: string): string => `${INTERVIEWS_API}/openings/${encodeURIComponent(openingId)}/spend`;

const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The money row's items: "Spending cap $150.00 · $0.00 spent · $0.00 set aside · $150.00 left · Up to $10.00 per interview". */
export function moneyLine(m: OpeningMoney): string[] {
  if (m.capUsd == null) return ['No spending cap yet: nothing that costs money can start in these interviews', `Up to ${usd(m.effectiveInterviewCapUsd)} per interview`];
  return [
    `Spending cap ${usd(m.capUsd)}`, `${usd(m.spentUsd)} spent`, `${usd(m.heldUsd)} set aside`, `${usd(m.leftUsd ?? 0)} left`,
    `Up to ${usd(m.effectiveInterviewCapUsd)} per interview${m.interviewCapUsd == null ? ' (the default)' : ''}`,
    ...(m.unknownCount ? [`${m.unknownCount} ${m.unknownCount === 1 ? 'cost' : 'costs'} not known yet`] : []),
  ];
}

export interface FieldProblem { path: string; message: string }

/** Only a technical round has the code pad; a behavioural round never does (row I1.8). */
export const roundHasPad = (type: RoundType): boolean => type === 'technical';
export const padLine = (type: RoundType): string => (roundHasPad(type) ? 'Code pad' : 'No code pad');

export const kitOf = (o: Pick<OpeningRecord, 'rounds' | 'competencies' | 'questions'>): OpeningKit =>
  structuredClone({ rounds: o.rounds, competencies: o.competencies, questions: o.questions });

/** The details form's values; the cap per interview comes from the opening's money (the record does not carry it). */
export const detailsOf = (o: OpeningRecord, interviewCapUsd: number | null = null): OpeningDetails => ({
  title: o.title, level: o.level, team: o.team, location: o.location, hiringManagerId: o.hiringManager?.id ?? null, state: o.state,
  budgetCapUsd: o.budgetCapUsd ?? null, interviewCapUsd,
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 rounds · 6 questions" — the Openings table's kit cell; kitTitle says the rest. */
export function kitLine(row: Pick<OpeningListRow, 'rounds' | 'kitSize'>): string {
  if (row.rounds.length === 0) return 'No kit yet';
  const { technical, behavioural } = row.kitSize.questions;
  return `${plural(row.rounds.length, 'round')} · ${technical + behavioural ? plural(technical + behavioural, 'question') : 'no questions'}`;
}

/** "4 technical and 2 behavioural questions; 5 competencies. Coding 60 min · …" — the kit cell's title. */
export function kitTitle(row: Pick<OpeningListRow, 'rounds' | 'kitSize'>): string {
  const { technical, behavioural } = row.kitSize.questions;
  return `${technical} technical and ${behavioural} behavioural ${technical + behavioural === 1 ? 'question' : 'questions'}; ${plural(row.kitSize.competencies, 'competency', 'competencies')}. ${roundsLine(row.rounds)}`;
}

/** "Coding 60 min · System design 60 min" for a title attribute. */
export const roundsLine = (rounds: readonly KitRound[]): string => rounds.map((r) => `${r.name} ${r.minutes} min`).join(' · ');

/** "Python, Go" — the languages a question has starter code in. */
export const starterLine = (q: KitQuestion): string =>
  PAD_LANGUAGES.filter((l) => q.starter?.[l] !== undefined).map((l) => PAD_LANGUAGE_LABELS[l]).join(', ');

/** A fresh id for a new item: `<prefix>-` and six letters or digits, not one of `taken`. */
export function newId(prefix: 'rd' | 'c' | 'q', taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (;;) {
    const id = `${prefix}-${Array.from({ length: 6 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)]).join('')}`;
    if (!taken.has(id)) return id;
  }
}

/** The list with item `index` moved one place up (-1) or down (1); unchanged at either end. */
export function moved<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export const blankRound = (id: string, type: RoundType = 'technical'): KitRound => ({ id, name: '', type, minutes: type === 'technical' ? 60 : 45, competencyIds: [] });

/** The round's list with `competencyId` ticked or unticked, kept in the kit's order. */
export function toggledCompetency(kit: Pick<OpeningKit, 'competencies'>, round: Pick<KitRound, 'competencyIds'>, competencyId: string): string[] {
  const on = new Set(round.competencyIds);
  if (on.has(competencyId)) on.delete(competencyId); else on.add(competencyId);
  return kit.competencies.map((c) => c.id).filter((id) => on.has(id));
}

/**
 * The kit without competency `id`, unticked from every round that assessed it. Whether it may go is the server's
 * "in use" rule (a competency rated on a scorecard stays); a round left with none is refused there too.
 */
export const withoutCompetency = (kit: OpeningKit, id: string): OpeningKit => ({
  ...kit,
  competencies: kit.competencies.filter((c) => c.id !== id),
  rounds: kit.rounds.map((r) => (r.competencyIds.includes(id) ? { ...r, competencyIds: r.competencyIds.filter((x) => x !== id) } : r)),
});
export const blankCompetency = (id: string): KitCompetency => ({ id, name: '', lookFor: '', anchors: { 1: '', 2: '', 3: '', 4: '' } });
export const blankQuestion = (id: string, roundType: RoundType, competencyId: string): KitQuestion => ({ id, prompt: '', followUps: [], competencyId, roundType });

/** What changed between the saved kit and the draft, for the save and discard prompts ("1 question added"). */
export function kitChanges(before: OpeningKit, after: OpeningKit): string[] {
  const out: string[] = [];
  const list = <T extends { id: string }>(a: readonly T[], b: readonly T[], one: string, many: string) => {
    const was = new Map(a.map((x) => [x.id, x]));
    const now = new Set(b.map((x) => x.id));
    const added = b.filter((x) => !was.has(x.id)).length;
    const removed = a.filter((x) => !now.has(x.id)).length;
    const edited = b.filter((x) => was.has(x.id) && JSON.stringify(was.get(x.id)) !== JSON.stringify(x)).length;
    if (added) out.push(`${plural(added, one, many)} added`);
    if (edited) out.push(`${plural(edited, one, many)} edited`);
    if (removed) out.push(`${plural(removed, one, many)} removed`);
    const kept = a.filter((x) => now.has(x.id)).map((x) => x.id);
    const order = b.filter((x) => was.has(x.id)).map((x) => x.id);
    if (!added && !removed && kept.join() !== order.join()) out.push(`${many} reordered`);
  };
  list(before.rounds, after.rounds, 'round', 'rounds');
  list(before.competencies, after.competencies, 'competency', 'competencies');
  list(before.questions, after.questions, 'question', 'questions');
  return out;
}

export const detailsChanged = (a: OpeningDetails, b: OpeningDetails): boolean => JSON.stringify(a) !== JSON.stringify(b);

/** "1 question added · the details" — a change list for a prompt, or null when nothing changed. */
export function changesLine(kit: readonly string[], details: boolean): string | null {
  const parts = [...kit, ...(details ? ['details edited'] : [])];
  if (!parts.length) return null;
  const line = parts.join(' · ');
  return line[0]!.toUpperCase() + line.slice(1);
}

/** The server's problems by path, and the paths each list's rows have problems on (to mark the row). */
export function problemsByPath(problems: readonly FieldProblem[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of problems) if (!m.has(p.path)) m.set(p.path, p.message);
  return m;
}
/** Row positions in `list` with a problem on any of their fields. */
export function rowsWithProblems(problems: ReadonlyMap<string, string>, list: 'rounds' | 'competencies' | 'questions'): Set<number> {
  const rows = new Set<number>();
  for (const path of problems.keys()) {
    const m = new RegExp(`^${list}\\.(\\d+)\\.`).exec(path);
    if (m) rows.add(Number(m[1]));
  }
  return rows;
}

// ── the writes ──────────────────────────────────────────────────────────────

export type SaveOutcome =
  | { ok: true; opening: OpeningRecord }
  | { ok: false; error: string; fields: FieldProblem[]; stale: boolean };

async function put(path: string, body: unknown): Promise<SaveOutcome> {
  const r = await writeJson<{ opening?: OpeningRecord; fields?: FieldProblem[] }>(`${INTERVIEWS_API}${path}`, 'PUT', body);
  if (r.ok && r.data?.opening) return { ok: true, opening: r.data.opening };
  return { ok: false, error: r.error ?? 'The change could not be saved. Try again.', fields: r.data?.fields ?? [], stale: r.status === 409 };
}

export const saveKit = (openingId: string, revision: number, kit: OpeningKit): Promise<SaveOutcome> =>
  put(`/openings/${encodeURIComponent(openingId)}/kit`, { revision, kit });

export const saveDetails = (openingId: string, revision: number, details: OpeningDetails): Promise<SaveOutcome> =>
  put(`/openings/${encodeURIComponent(openingId)}/details`, { revision, ...details });

export async function createOpening(details: OpeningDetails): Promise<SaveOutcome> {
  const r = await writeJson<{ opening?: OpeningRecord; fields?: FieldProblem[] }>(`${INTERVIEWS_API}/openings`, 'POST', details);
  if (r.ok && r.data?.opening) return { ok: true, opening: r.data.opening };
  return { ok: false, error: r.error ?? 'The opening could not be created. Try again.', fields: r.data?.fields ?? [], stale: false };
}

export const BLANK_DETAILS: OpeningDetails = { title: '', level: '', team: '', location: '', hiringManagerId: null, state: 'open', budgetCapUsd: null, interviewCapUsd: null };

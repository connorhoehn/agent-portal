// The candidates list as the flush list rail beside an open profile (docs/layout-cascade.md): the viewer's own
// list, grouped by stage in the pipeline's order, name over the opening. A recruiter or admin reads every
// candidate (GET /candidates), a hiring manager the candidates on their openings (GET /openings' pipelines).
// An interviewer has no candidates list (theirs is rounds), so they get no rail.
import {
  STAGE_LABELS, STAGE_ORDER, type ApplicationStage, type CandidateRow, type OpeningRow,
} from './interviews.ts';

export type RailKind = 'candidates' | 'openings';

/** Which list a role's rail reads; null where the role has none. */
export function railKindFor(role: string | null | undefined): RailKind | null {
  if (role === 'recruiter' || role === 'admin') return 'candidates';
  if (role === 'hiring-manager') return 'openings';
  return null;
}

/** The frame's title and the rail's labels: the collection's name, so it does not jump between records. */
export function railNames(kind: RailKind): { title: string; listTitle: string; listLabel: string; placeholder: string; description: string } {
  return kind === 'openings'
    ? { title: 'My openings', listTitle: 'Candidates', listLabel: 'candidates on your openings', placeholder: 'Find a candidate', description: 'The candidates on the openings you are hiring for.' }
    : { title: 'Candidates', listTitle: 'Candidates', listLabel: 'candidates', placeholder: 'Find a candidate', description: 'Everyone in the hiring pipeline.' };
}

export interface RailEntry { id: string; name: string; headline: string; opening: string; stage: ApplicationStage }

/** Recruiter and admin: one entry per candidate (their first application in the list's order). */
export function entriesFromCandidates(rows: readonly CandidateRow[]): RailEntry[] {
  return dedupe(rows.map((r) => ({ id: r.candidate.id, name: r.candidate.name, headline: r.candidate.headline, opening: r.opening.title, stage: r.stage })));
}

/** Hiring manager: the candidates in their openings' pipelines. */
export function entriesFromOpenings(openings: readonly OpeningRow[]): RailEntry[] {
  return dedupe(openings.flatMap((o) => o.pipeline.map((p) => ({ id: p.candidate.id, name: p.candidate.name, headline: p.candidate.headline, opening: o.title, stage: p.stage }))));
}

function dedupe(entries: RailEntry[]): RailEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

export interface RailGroup { id: string; title: string; count: number }
export interface RailRow { id: string; groupId: string; title: string; subline: string }

const norm = (s: string) => s.toLowerCase();

/** The find box: every word typed must appear in the name, headline, opening or stage. */
export function railMatches(entry: RailEntry, query: string): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm(`${entry.name} ${entry.headline} ${entry.opening} ${STAGE_LABELS[entry.stage]}`);
  return words.every((w) => hay.includes(w));
}

/**
 * The rail's groups and rows: stages in the pipeline's order (empty ones left out), names A to Z inside a stage.
 * `openId` is kept in the rows even when the find box would hide it, so the open candidate never vanishes.
 */
export function railModel(entries: readonly RailEntry[], query: string, openId: string | null): { groups: RailGroup[]; rows: RailRow[]; total: number } {
  const shown = entries.filter((e) => e.id === openId || railMatches(e, query));
  const ordered = [...shown].sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || a.name.localeCompare(b.name));
  const groups = STAGE_ORDER
    .map((s) => ({ id: s, title: STAGE_LABELS[s], count: ordered.filter((e) => e.stage === s).length }))
    .filter((g) => g.count > 0);
  return {
    groups,
    rows: ordered.map((e) => ({ id: e.id, groupId: e.stage, title: e.name, subline: e.opening })),
    total: entries.length,
  };
}

/** What a not-found inside the candidate frame calls the page: never the id from the address (finding I1.2m). */
export const CANDIDATE_NOT_FOUND = 'Candidate not found';

/**
 * The breadcrumb's label for a candidate page: the name once read, "Candidate not found" when the read is a not-found
 * (`failure.status` 404, or an error that says so), else nothing yet (the trail waits for the name).
 */
export function candidateCrumbLabel(name: string | null | undefined, error: string | null | undefined, status?: number | null): string | undefined {
  if (name) return name;
  if (status === 404 || (error && /404|not found/i.test(error))) return CANDIDATE_NOT_FOUND;
  return undefined;
}

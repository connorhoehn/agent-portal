// Which assessment search docs a writer may have changed (docs/user-search-goal.md S2).
// A scoring pass, a run or a submission commit touches a team's dimension,
// exception, feedback, run, submission and story docs together, so writers name
// the TEAM (or the document set) and this resolves the docs to re-project: what
// the provider holds now PLUS what the index already holds for it, so a record
// that went away (a deleted team, an answered follow-up) is removed rather than
// left stale. Not built yet -> nothing to do (the first build reads the commit).
//
// Loaded lazily by the providers' writers (the projection imports those providers back).

import type { SearchWriteRef } from './writes.js';

const T = 'assessment' as const;
const ref = (type: string, id: string): SearchWriteRef => ({ tenant: T, type, id });
const unique = (refs: SearchWriteRef[]) => [...new Map(refs.map(r => [`${r.type}:${r.id}`, r])).values()];

async function indexed() {
  const registry = await import('./registry.js');
  if (!(await registry.isIndexed(T))) return null;
  return { index: registry.searchIndex(), partition: registry.partitionFor(T) };
}

/** The docs hanging off these teams (their own, and every team-keyed record). */
export async function assessmentTeamRefs(teamIds: readonly string[], extra: SearchWriteRef[] = []): Promise<SearchWriteRef[]> {
  const ctx = await indexed();
  if (!ctx) return [];
  const [M, P] = await Promise.all([import('../../mock/assessment.js'), import('../../providers/assessment.js')]);
  const refs: SearchWriteRef[] = [...extra];
  for (const teamId of new Set(teamIds)) {
    refs.push(ref('team', teamId));
    for (const d of M.DIMENSION_IDS) { refs.push(ref('dimension', `${teamId}:${d}`), ref('exception', `${teamId}:${d}`)); }
    const [feedback, runs, subs, stories] = await Promise.all([
      P.listFeedback({ team: teamId }).catch(() => []), P.listRuns({ team: teamId, limit: 500 }).catch(() => []),
      P.listSubmissions().catch(() => ({ envelopes: [] as Array<{ team_id: string; envelope_id: string }> })), P.listStories(teamId).catch(() => null),
    ]);
    feedback.forEach(t => refs.push(ref('feedback', t.task_id)));
    runs.forEach(r => refs.push(ref('run', r.id)));
    subs.envelopes.filter(e => e.team_id === teamId).forEach(e => refs.push(ref('submission', e.envelope_id)));
    (stories ?? []).forEach(s => refs.push(ref('story', `${s.team_id}/${s.filename}`)));
    const held = await ctx.index.query({ tenant: ctx.partition, terms: [], facets: { team: [teamId] } });
    held.docs.forEach(d => refs.push(ref(d.type, d.id)));
  }
  return unique(refs);
}

/** Every team (configuration moves the target level every team is measured against; a submission batch spans teams). */
export async function assessmentAllTeamRefs(extra: SearchWriteRef[] = []): Promise<SearchWriteRef[]> {
  const ctx = await indexed();
  if (!ctx) return [];
  const P = await import('../../providers/assessment.js');
  const ids = new Set((await P.listTeams().catch(() => [])).map(t => t.id));
  (await ctx.index.query({ tenant: ctx.partition, terms: [], types: ['team'] })).docs.forEach(d => ids.add(d.id));
  return assessmentTeamRefs([...ids], extra);
}

/** The workspace documents: named ones, or all of them (a move, rename, publish or pull changes the tree). */
export async function assessmentDocumentRefs(ids?: readonly string[]): Promise<SearchWriteRef[]> {
  const ctx = await indexed();
  if (!ctx) return [];
  if (ids) return ids.map(id => ref('document', id));
  const P = await import('../../providers/assessment.js');
  const refs: SearchWriteRef[] = [];
  for (const s of (await P.getKnowledgeTree().catch(() => ({ sections: [] }))).sections) s.nodes.filter(n => !n.is_dir).forEach(n => refs.push(ref('document', n.id)));
  (await ctx.index.query({ tenant: ctx.partition, terms: [], types: ['document'] })).docs.forEach(d => refs.push(ref('document', d.id)));
  return unique(refs);
}

/** A run's own doc and its team's docs (the team is looked up only when the index is built). */
export async function assessmentRunRefs(runId: string): Promise<SearchWriteRef[]> {
  if (!(await indexed())) return [];
  const P = await import('../../providers/assessment.js');
  const run = await P.getRun(runId).catch(() => null);
  return assessmentTeamRefs(run?.team_id ? [run.team_id] : [], [ref('run', runId)]);
}

export const assessmentRunRef = (runId: string): SearchWriteRef => ref('run', runId);
export const assessmentFeedbackRef = (taskId: string): SearchWriteRef => ref('feedback', taskId);

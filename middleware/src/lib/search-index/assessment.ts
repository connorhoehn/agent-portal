// The assessment tenant's search projection (docs/user-search-goal.md S2).
//
// Doc types: team, dimension (a team's score on one dimension), exception (an
// N/A exception request and who decided it), feedback (a follow-up / exception
// review task), run (an agent run), submission (a Forms envelope), story and
// document (the workspace's knowledge docs). Every row is read through the
// assessment provider (mock fixtures under MOCK_AURORA, Aurora otherwise).
//
// ACL: the route is gated on ViewAssessment (index.ts), and every record a
// ViewAssessment reader may list is searchable, so docs carry no `acl`.
// Recordings are NOT projected: they are participant-private and read live
// from the platform per reader (providers/recording-search.ts), so the
// "huddle recording" intent stays on the recording search endpoint.
//
// Update on write: the assessment providers call `noteSearchWrite({ tenant:
// 'assessment', type, id })` after their commit (scripts/check-search-writers.mjs).

import { config } from '../../config.js';
import * as M from '../../mock/assessment.js';
import * as A from '../../providers/assessment-aurora.js';
import {
  getKnowledgeTree, listFeedback, listRuns, listStories, listSubmissions, listTeams, listExceptions, type TeamSummary,
} from '../../providers/assessment.js';
import { listAssessmentTeamRosters } from '../../providers/assessment-team-members.js';
import type { PhraseRule, TenantBuild, TenantIndexSpec } from './tenants.js';
import { docKey, type SearchDoc, type SearchDocEdge } from './types.js';

export const ASSESSMENT_DOC_TYPES = ['team', 'dimension', 'exception', 'feedback', 'run', 'submission', 'story', 'document'] as const;
export type AssessmentDocType = typeof ASSESSMENT_DOC_TYPES[number];
const enc = encodeURIComponent;

const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
function doc(tenant: string, type: AssessmentDocType, id: string, d: Partial<SearchDoc> & { title: string; record: Record<string, unknown> }): SearchDoc {
  return {
    tenant, type, id, title: d.title, text: d.text ?? '',
    facets: Object.fromEntries(Object.entries(d.facets ?? {}).map(([k, v]) => [k, [...new Set(v.filter(Boolean))]]).filter(([, v]) => v.length)),
    people: [...new Set(d.people ?? [])], edges: d.edges ?? [], acl: null, updatedAt: d.updatedAt ?? null, record: compact(d.record),
  };
}
const isoOrNull = (raw: unknown): string | null => {
  if (raw == null || raw === '') return null;
  const t = String(raw).trim();
  const d = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t.includes('T') ? t : t.replace(' ', 'T')}Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
const edge = (source: string, target: string, label: string): SearchDocEdge => ({ id: `${source}:${label}:${target}`, source, target, label });
const teamKey = (id: string) => docKey('team', id);
const dimTitle = (id: string, version?: string) => M.rubricDimension(id, version)?.title ?? `Dimension ${id}`;
const hrefTeam = (id: string) => `/assessment/teams/${enc(id)}`;

// ── readers (mock fixtures or Aurora, as the providers do) ──────────────────

async function dimsOf(teamId: string): Promise<Record<string, M.MockDimensionScore>> {
  return config.mock.aurora ? (M.scoresFor(teamId) ?? {}) : A.fetchDimensionScores(teamId);
}
async function teamRow(teamId: string): Promise<M.MockTeam | null> {
  return config.mock.aurora ? (M.teams().find(t => t.id === teamId) ?? null) : A.fetchTeam(teamId);
}

// ── per-type docs ───────────────────────────────────────────────────────────

interface TeamFacts { summary: TeamSummary; team: M.MockTeam | null; dims: Record<string, M.MockDimensionScore>; members: Array<{ userId: string; role: string }> }

export function teamDoc(tenant: string, f: TeamFacts): SearchDoc {
  const s = f.summary, c = s.certification;
  const lead = s.assessment_lead?.trim() || '';
  const dims = Object.values(f.dims);
  const overclaimed = dims.filter(d => !d.is_na && (d.cap_applied || (d.self_claimed_level != null && d.current_level != null && d.self_claimed_level > d.current_level)));
  const level = c.max_verified_level;
  const below = c.assessed > 0 && c.at_or_above_target === 0;
  const white = s.cohort === 'white_glove';
  const text = [
    `TEAM-${s.id.replace(/^TEAM-/, '')}`, s.id, lead ? `lead ${lead}` : 'no lead unassigned without a lead',
    white ? 'white glove white-glove' : s.cohort_label,
    level != null ? `level ${level}` : 'not yet assessed',
    below ? `below target under level ${c.target_level}` : '',
    overclaimed.length ? `over-claimed claims above scored capped cap applied on ${overclaimed.map(d => dimTitle(d.dimension_id, f.team?.rubric_version)).join(', ')}` : '',
    f.team?.archetype ?? '', (f.team?.repos ?? []).map(r => r.name).join(' '), s.contributors.map(x => x.name).join(' '), (f.team?.contacts ?? []).join(' '),
    c.headline, s.status.replace(/_/g, ' '),
  ].join(' ');
  return doc(tenant, 'team', s.id, {
    title: s.name, text,
    facets: {
      lead: [lead ? lead.toLowerCase() : 'unassigned'], cohort: [s.cohort], whitegloved: white ? ['true'] : [],
      belowtarget: below ? ['true'] : [], overclaimed: overclaimed.length ? ['true'] : [],
      level: level != null ? [String(level)] : [], status: [s.status.toLowerCase()],
      member: f.members.map(m => m.userId),
    },
    people: f.members.map(m => m.userId),
    updatedAt: isoOrNull(s.updated_at),
    record: {
      kind: 'Team', status: s.status.toLowerCase().replace(/_/g, ' '), href: hrefTeam(s.id), lead: lead || undefined,
      subtitle: [s.id, lead ? `Lead: ${lead}` : 'No lead', s.contributors.length ? `With ${s.contributors.slice(0, 3).map(x => x.name).join(', ')}` : '', s.cohort_label, level != null ? `Level ${level}` : 'Not yet assessed'].filter(Boolean).join(' · '),
      description: c.headline,
    },
  });
}

export function dimensionDoc(tenant: string, team: Pick<TeamSummary, 'id' | 'name'>, rubricVersion: string | undefined, d: M.MockDimensionScore): SearchDoc {
  const title = dimTitle(d.dimension_id, rubricVersion);
  const over = !d.is_na && (d.cap_applied || (d.self_claimed_level != null && d.current_level != null && d.self_claimed_level > d.current_level));
  const facts = d.is_na ? 'not applicable' : `self-claimed ${d.self_claimed_level ?? 'none'}, scored ${d.current_level ?? 'not yet'}`;
  return doc(tenant, 'dimension', `${team.id}:${d.dimension_id}`, {
    title: `${team.name} · ${title}`,
    text: `${team.id} dimension ${d.dimension_id} ${title} ${facts} ${over ? 'over-claimed capped cap applied claim open' : ''} ${d.evidence.map(e => e.excerpt).join(' ')}`,
    facets: { team: [team.id], overclaimed: over ? ['true'] : [] },
    edges: [edge(teamKey(team.id), docKey('dimension', `${team.id}:${d.dimension_id}`), 'dimension')],
    updatedAt: isoOrNull(d.updated_at),
    record: { kind: 'Dimension', subtitle: `${team.id} dimension ${d.dimension_id} · ${facts}`, description: d.evidence[0]?.excerpt, href: hrefTeam(team.id) },
  });
}

export function exceptionDoc(tenant: string, team: Pick<TeamSummary, 'id' | 'name'>, rubricVersion: string | undefined, x: M.TeamException): SearchDoc {
  const title = dimTitle(x.dimension_id, rubricVersion);
  const decided = x.status !== 'requested';
  return doc(tenant, 'exception', `${team.id}:${x.dimension_id}`, {
    title: `${team.name} · ${title} N/A exception`,
    text: `${team.id} dimension ${x.dimension_id} ${title} N/A exception ${x.status} ${x.source} ${x.reason} ${decided ? `${x.status} by ${x.approved_by}` : 'awaiting approval'} requested by ${x.requested_by ?? ''}`,
    facets: { team: [team.id], state: [decided ? 'closed' : 'open'], status: [x.status] },
    people: [x.approved_by, x.requested_by ?? ''].filter(Boolean),
    edges: [edge(teamKey(team.id), docKey('exception', `${team.id}:${x.dimension_id}`), 'exception')],
    updatedAt: isoOrNull(x.approved_at),
    record: {
      kind: 'Exception', status: x.status, href: hrefTeam(team.id), teamId: team.id, teamName: team.name, dimensionId: x.dimension_id, dimension: title,
      approvedBy: decided ? x.approved_by : undefined,
      subtitle: `${team.id} dimension ${x.dimension_id} · ${x.status}${decided && x.approved_by ? ` by ${x.approved_by}` : ''}`, description: x.reason,
    },
  });
}

export function feedbackDoc(tenant: string, t: M.FeedbackTask & { virtual?: boolean }, teamName: string | null): SearchDoc {
  const dim = t.dimension_id ? dimTitle(t.dimension_id) : '';
  const open = t.status === 'OPEN';
  const review = t.kind === 'exception_review';
  return doc(tenant, 'feedback', t.task_id, {
    title: t.question.length > 110 ? `${t.question.slice(0, 107)}…` : t.question,
    text: `${t.question} ${t.response ?? ''} ${t.team_id ?? ''} ${teamName ?? ''} ${t.dimension_id ? `dimension ${t.dimension_id} ${dim}` : ''} ${t.kind.replace(/_/g, ' ')} ${t.status.toLowerCase()} question ${open ? 'open pending' : 'answered resolved'}`,
    facets: { team: [t.team_id ?? ''], kind: [t.kind], state: [open ? 'open' : 'closed'], status: [t.status.toLowerCase()] },
    edges: t.team_id ? [edge(teamKey(t.team_id), docKey('feedback', t.task_id), 'feedback')] : [],
    updatedAt: isoOrNull(t.resolved_at ?? t.created_at),
    record: {
      kind: review ? 'Exception review' : 'Feedback', status: t.status.toLowerCase(), href: `/assessment/feedback/${enc(t.task_id)}`,
      question: t.question, response: t.response ?? undefined, teamId: t.team_id ?? undefined, teamName: teamName ?? undefined, dimensionId: t.dimension_id ?? undefined, dimension: dim || undefined, taskKind: t.kind,
      subtitle: [t.team_id, t.dimension_id ? `dimension ${t.dimension_id}${dim ? ` (${dim})` : ''}` : '', t.kind.replace(/_/g, ' '), t.status.toLowerCase()].filter(Boolean).join(' · '),
      description: t.response ?? undefined,
    },
  });
}

export function runDoc(tenant: string, r: M.MockRun, teamName: string | null): SearchDoc {
  return doc(tenant, 'run', r.id, {
    title: `${r.command}${teamName ? ` on ${teamName}` : ''}`,
    text: `${r.command} run ${r.id} ${r.team_id ?? ''} ${teamName ?? ''} ${r.status} ${r.status === 'failed' ? 'failed failure' : r.status === 'running' ? 'running in progress now' : 'completed'} ${r.summary} ${r.error ?? ''} ${r.source}`,
    facets: { status: [r.status], command: [r.command], team: [r.team_id ?? ''] },
    edges: r.team_id ? [edge(teamKey(r.team_id), docKey('run', r.id), 'run')] : [],
    updatedAt: isoOrNull(r.finished_at ?? r.started_at),
    record: { kind: 'Run', status: r.status, href: `/assessment/runs/${enc(r.id)}`, subtitle: [r.team_id, r.status, r.error ?? r.summary].filter(Boolean).join(' · '), description: r.summary },
  });
}

export function submissionDoc(tenant: string, e: M.SubmissionEnvelope & { team_id: string }, teamName: string | null): SearchDoc {
  const who = e.submitter.name || 'Unknown submitter';
  return doc(tenant, 'submission', e.envelope_id, {
    title: `${who}'s submission${teamName ? ` for ${teamName}` : ''}`,
    text: `${who} ${e.submitter.email} ${e.envelope_id} ${e.team_name_raw} ${e.team_id} ${teamName ?? ''} ${e.status} ${e.status === 'staged' ? 'staged not committed' : ''} submission revision ${e.revision} ${e.source.kind} ${e.source.origin_file}`,
    facets: { status: [e.status], team: [e.team_id] },
    edges: [edge(teamKey(e.team_id), docKey('submission', e.envelope_id), 'submission')],
    updatedAt: isoOrNull(e.ingested_at),
    record: { kind: 'Submission', status: e.status, submitter: e.submitter.name || undefined, teamId: e.team_id, teamName: teamName ?? undefined, href: `/assessment/submissions/${enc(e.envelope_id)}`, subtitle: [e.team_id, `from ${who}`, e.status].join(' · '), description: e.dimension_hints.map(h => h.dimension_id).length ? `${e.dimension_hints.length} dimension hints` : undefined },
  });
}

export function storyDoc(tenant: string, s: M.StoryDraft, teamName: string | null): SearchDoc {
  return doc(tenant, 'story', `${s.team_id}/${s.filename}`, {
    title: s.title,
    text: `${s.markdown} ${s.team_id} ${teamName ?? ''} dimension ${s.dimension_id} ${dimTitle(s.dimension_id)} story ${s.status} ${s.jira_key ?? ''}`,
    facets: { team: [s.team_id], status: [s.status] },
    edges: [edge(teamKey(s.team_id), docKey('story', `${s.team_id}/${s.filename}`), 'story')],
    updatedAt: isoOrNull(s.created_at),
    record: { kind: 'Story', status: s.status, href: hrefTeam(s.team_id), subtitle: [s.team_id, teamName, `dimension ${s.dimension_id}`, s.status].filter(Boolean).join(' · ') },
  });
}

export function documentDoc(tenant: string, n: { id: string; title: string; section: string; updated_at?: string; classification?: string }, markdown: string | null): SearchDoc {
  return doc(tenant, 'document', n.id, {
    title: n.title, text: `${markdown ?? ''} ${n.section} workspace document standard ${n.classification ?? ''}`,
    facets: { section: [n.section] }, updatedAt: isoOrNull(n.updated_at),
    record: { kind: 'Document', href: `/assessment/workspace?doc=${enc(n.id)}`, subtitle: `Workspace · ${n.section}`, description: markdown ? markdown.replace(/[#*_`>-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : undefined },
  });
}

// ── the rebuild ─────────────────────────────────────────────────────────────

async function teamFacts(summary: TeamSummary, rosters: Map<string, Array<{ userId: string; role: string }>>): Promise<TeamFacts> {
  const [team, dims] = await Promise.all([teamRow(summary.id), dimsOf(summary.id)]);
  return { summary, team, dims, members: rosters.get(summary.id) ?? [] };
}

function dimensionDocsOf(tenant: string, f: TeamFacts): SearchDoc[] {
  return Object.values(f.dims)
    .filter(d => d.is_na || d.current_level != null || d.self_claimed_level != null)
    .map(d => dimensionDoc(tenant, f.summary, f.team?.rubric_version, d));
}

export async function buildAssessmentDocs(tenant: string): Promise<TenantBuild> {
  const partial: string[] = [];
  let failed = false;
  async function read<T>(name: string, p: Promise<T>, fallback: T): Promise<T> {
    try { return await p; } catch { partial.push(`${name} unavailable`); failed = true; return fallback; }
  }
  const teams = await read('Teams', listTeams(), [] as TeamSummary[]);
  const names = new Map(teams.map(t => [t.id, t.name]));
  const rosters = await read('Team members', listAssessmentTeamRosters(teams.map(t => t.id)), new Map());
  const [facts, feedback, runs, subs, tree] = await Promise.all([
    Promise.all(teams.map(t => teamFacts(t, rosters))),
    read('Feedback', listFeedback({}), []),
    read('Runs', listRuns({ limit: 500 }), []),
    read('Submissions', listSubmissions(), { envelopes: [], groups: [] }),
    read('Documents', getKnowledgeTree(), { sections: [] as M.KnowledgeSection[] }),
  ]);
  const stories = await Promise.all(teams.map(t => read('Stories', listStories(t.id), [] as M.StoryDraft[] | null)));
  const exceptions = await Promise.all(teams.map(t => read('Exceptions', listExceptions(t.id), null)));
  const docs: SearchDoc[] = [];
  facts.forEach(f => { docs.push(teamDoc(tenant, f), ...dimensionDocsOf(tenant, f)); });
  teams.forEach((t, i) => (exceptions[i]?.exceptions ?? []).forEach(x => docs.push(exceptionDoc(tenant, t, facts[i]!.team?.rubric_version, x))));
  feedback.forEach(t => docs.push(feedbackDoc(tenant, t, t.team_id ? names.get(t.team_id) ?? null : null)));
  runs.forEach(r => docs.push(runDoc(tenant, r, r.team_id ? names.get(r.team_id) ?? null : null)));
  subs.envelopes.forEach(e => docs.push(submissionDoc(tenant, e, names.get(e.team_id) ?? null)));
  stories.forEach(list => (list ?? []).forEach(s => docs.push(storyDoc(tenant, s, names.get(s.team_id) ?? null))));
  for (const section of tree.sections) {
    for (const n of section.nodes.filter(x => !x.is_dir)) {
      const body = config.mock.aurora ? (M.findKnowledgeDoc(n.id)?.markdown ?? null) : null;
      docs.push(documentDoc(tenant, { id: n.id, title: n.title, section: section.title, ...(n.updated_at ? { updated_at: n.updated_at } : {}), ...(n.classification ? { classification: n.classification } : {}) }, body));
    }
  }
  return { docs, partial: [...new Set(partial)], failed };
}

/** One record re-read after a write. */
export async function projectAssessmentRecord(tenant: string, type: string, id: string): Promise<SearchDoc | null> {
  switch (type as AssessmentDocType) {
    case 'team': {
      const s = (await listTeams()).find(t => t.id === id);
      if (!s) return null;
      const rosters = await listAssessmentTeamRosters([id]);
      return teamDoc(tenant, await teamFacts(s, rosters));
    }
    case 'dimension': {
      const [teamId, dimId] = id.split(':');
      const s = (await listTeams()).find(t => t.id === teamId);
      if (!s || !dimId) return null;
      const f = await teamFacts(s, new Map());
      const d = f.dims[dimId];
      return d && (d.is_na || d.current_level != null || d.self_claimed_level != null) ? dimensionDoc(tenant, s, f.team?.rubric_version, d) : null;
    }
    case 'exception': {
      const [teamId, dimId] = id.split(':');
      const s = (await listTeams()).find(t => t.id === teamId);
      const x = s ? (await listExceptions(s.id))?.exceptions.find(e => e.dimension_id === dimId) : undefined;
      return s && x ? exceptionDoc(tenant, s, (await teamRow(s.id))?.rubric_version, x) : null;
    }
    case 'feedback': {
      const t = (await listFeedback({})).find(x => x.task_id === id);
      if (!t) return null;
      const name = t.team_id ? (await listTeams()).find(x => x.id === t.team_id)?.name ?? null : null;
      return feedbackDoc(tenant, t, name);
    }
    case 'run': {
      const r = (await listRuns({ limit: 500 })).find(x => x.id === id);
      if (!r) return null;
      const name = r.team_id ? (await listTeams()).find(x => x.id === r.team_id)?.name ?? null : null;
      return runDoc(tenant, r, name);
    }
    case 'submission': {
      const e = (await listSubmissions()).envelopes.find(x => x.envelope_id === id);
      if (!e) return null;
      return submissionDoc(tenant, e, (await listTeams()).find(x => x.id === e.team_id)?.name ?? null);
    }
    case 'story': {
      const [teamId, filename] = id.split('/');
      const s = (await listStories(teamId ?? ''))?.find(x => x.filename === filename);
      return s ? storyDoc(tenant, s, (await listTeams()).find(x => x.id === s.team_id)?.name ?? null) : null;
    }
    case 'document': {
      const tree = await getKnowledgeTree();
      for (const section of tree.sections) {
        const n = section.nodes.find(x => x.id === id && !x.is_dir);
        if (n) return documentDoc(tenant, { id: n.id, title: n.title, section: section.title, ...(n.updated_at ? { updated_at: n.updated_at } : {}), ...(n.classification ? { classification: n.classification } : {}) }, config.mock.aurora ? (M.findKnowledgeDoc(n.id)?.markdown ?? null) : null);
      }
      return null;
    }
  }
  return null;
}

// ── phrase rules (U7) ───────────────────────────────────────────────────────

const RULES: PhraseRule[] = [
  { re: /'s\b|\bthis (?:week|month)\b|\blast (?:week|month)\b|\bn\/a\b|\bright now\b|\bnow\b/i },
  // "who approved the security testing exception for Northstar" -> the exception, with its approver in the text
  { re: /\bwho approved\b|\bapprover of\b|\bapproved by\b|\bapproved\b/i, types: ['exception'] },
  { re: /\bmy teams?\b|\bteams? (?:i'm|i am) (?:on|in|assigned(?: to)?)\b|\bteams am i (?:assigned(?: to)?|on)\b/i, types: ['team'], facets: { member: ['@me'] } },
  { re: /\b(?:below|under|beneath) (?:the )?target\b|\b(?:below|under) level \d\b|\blowest[- ]scoring\b/i, types: ['team'], facets: { belowtarget: ['true'] } },
  { re: /\bwhite[- ]?glove\b/i, types: ['team'], facets: { whitegloved: ['true'] } },
  { re: /\b(?:without|with no|have no|has no|no) (?:a )?lead\b|\bunassigned\b/i, types: ['team'], facets: { lead: ['unassigned'] } },
  { re: /\bover[- ]?claim(?:ed|s)?\b|\bself[- ]claimed vs\.? scored(?: gaps?)?\b|\bwhere was the cap applied\b|\bcapped\b|\bcap applied\b/i, types: ['team', 'dimension'], facets: { overclaimed: ['true'] } },
  { re: /\bfail(?:ed|ing|ures?)\b/i, types: ['run'], facets: { status: ['failed'] } },
  { re: /\b(?:running|in[- ]progress)\b/i, types: ['run'], facets: { status: ['running'] } },
  { re: /\bstaged\b|\bnot (?:yet )?committed\b/i, types: ['submission'], facets: { status: ['staged'] } },
  { re: /\b(?:open|pending|unresolved|awaiting)\b[^.?]*\bexceptions?\b|\bexceptions?\b[^.?]*\b(?:need|needs|awaiting|pending|open)\b[^.?]*/i, types: ['feedback', 'exception'], facets: { state: ['open'] } },
  { re: /\banswered\b/i, types: ['feedback'], facets: { state: ['closed'] } },
  { re: /\bwho leads\b|\b(?:team )?lead (?:for|of)\b|\bteam lead\b|\blead\b/i, types: ['team'] },
];

export const assessmentSpec: TenantIndexSpec = {
  tenant: 'assessment',
  types: ASSESSMENT_DOC_TYPES,
  labels: { team: 'Team', dimension: 'Dimension', exception: 'Exception', feedback: 'Feedback', run: 'Run', submission: 'Submission', story: 'Story', document: 'Document' },
  acls: [],
  build: buildAssessmentDocs,
  project: projectAssessmentRecord,
  rules: RULES,
  scaffold: ['assessment', 'assessments', 'confirm', 'confirmed', 'confirms', 'questions', 'question', 'gaps', 'gap', 'scoring', 'scored', 'review', 'reviews'],
};

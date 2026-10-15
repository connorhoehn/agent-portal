// The orgiq search projection: the providers' records as SearchDocs
// (docs/user-search-goal.md U1, U4, U5). Two entry points, one shape:
//
//   buildOrgiqDocs()          the rebuild — every record, read the way /api/search used to read them per request
//   projectOrgiqRecord(ref)   one record re-read after a write (lib/search-index/writes.ts)
//
// Doc types: person, team, initiative, work, decision (decisions + approved
// designs), knowledge, asset. Recordings are NOT projected: they are
// participant-private and resolved per reader (providers/recording-search.ts),
// so /api/search keeps reading them live.
//
// Edges are filed on the doc that owns the fact: an initiative owns its
// owner/SME/contributor edges, a work item its includes/assigned-to edges, a
// decision its decider/contributor edges, a team its member edges, a person
// the collaborations it is the source of. People docs and team docs need
// ViewOrgChart (`acl`), as the people graph did.

import { aurora } from '../../providers/index.js';
import { listProjects, listProjectSummaries, getProject, type ProjectSummary, type ProjectDetail } from '../../providers/projects.js';
import { searchWorkItems, getWorkItem, type WorkItem } from '../../providers/work-items.js';
import { listDesignReviews, getDesignThread, type DesignReview } from '../../providers/design-reviews.js';
import { listDecisions, getDecision, type DecisionDetail } from '../../providers/decisions.js';
import { listRunbookSearchEntries, getRunbookSearchEntry, type RunbookSearchEntry } from '../runbooks/search-entries.js';
import { listAssets, getAsset, type LibraryAsset } from '../../providers/prompt-library.js';
import { listOrgTeams, type OrgTeamRoster } from '../../providers/org-teams.js';
import type { Person, Relationship } from '../../providers/types.js';
import { docKey, type SearchDoc, type SearchDocEdge } from './types.js';

export const ORGIQ_DOC_TYPES = ['person', 'team', 'initiative', 'work', 'decision', 'knowledge', 'asset'] as const;
export type OrgiqDocType = typeof ORGIQ_DOC_TYPES[number];
export const PEOPLE_ACL = 'ViewOrgChart';
const enc = encodeURIComponent;

/** Normalise a source timestamp to ISO; a zone-less string is UTC (the Data API's naive TIMESTAMPTZ). Never invents one. */
export function isoOrNull(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const isoish = text.includes('T') ? text : text.replace(' ', 'T');
  const d = new Date(hasZone ? isoish : `${isoish}Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

const edge = (source: string, target: string, label: string, weight?: number): SearchDocEdge =>
  ({ id: `${source}:${label}:${target}`, source, target, label, ...(weight != null ? { weight } : {}) });
const uniqueEdges = (edges: SearchDocEdge[]) => [...new Map(edges.map(e => [e.id, e])).values()];
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const person = (id: string) => docKey('person', id);
const initiative = (id: string) => docKey('initiative', id);

function doc(tenant: string, type: OrgiqDocType, id: string, d: Partial<SearchDoc> & { title: string; record: Record<string, unknown> }): SearchDoc {
  return {
    tenant, type, id, title: d.title, text: d.text ?? '', facets: Object.fromEntries(Object.entries(d.facets ?? {}).map(([k, v]) => [k, [...new Set(v.filter(Boolean))]]).filter(([, v]) => v.length)),
    people: [...new Set(d.people ?? [])], edges: uniqueEdges(d.edges ?? []), acl: d.acl ?? null, updatedAt: d.updatedAt ?? null, record: compact(d.record),
  };
}

// ── per-type docs ────────────────────────────────────────────────────────────

export function personDoc(tenant: string, p: Pick<Person, 'id' | 'name' | 'title' | 'department' | 'skills' | 'avatarUrl'>, relationships: Relationship[]): SearchDoc {
  const subtitle = [p.title, p.department].filter(Boolean).join(' · ');
  const collaborations = relationships.filter(r => r.type === 'collaborates' && r.source === p.id && r.target !== p.id);
  return doc(tenant, 'person', p.id, {
    title: p.name, text: `${p.skills.join(', ')} ${subtitle}`,
    facets: { skill: p.skills, department: [p.department], title: [p.title] },
    people: [p.id], acl: PEOPLE_ACL,
    edges: collaborations.map(r => edge(person(r.source), person(r.target), 'collaborates', r.strength)),
    record: { description: p.skills.join(', '), subtitle, ...(p.avatarUrl?.trim() ? { avatarUrl: p.avatarUrl } : {}), href: `/iq/search?tab=connections&selection=${enc(person(p.id))}` },
  });
}

export function teamDoc(tenant: string, t: OrgTeamRoster): SearchDoc {
  const count = `${t.members.length} ${t.members.length === 1 ? 'member' : 'members'}`;
  return doc(tenant, 'team', t.id, {
    title: t.name, text: 'team',
    facets: { member: t.members.map(m => m.personId) },
    people: t.members.map(m => m.personId), acl: PEOPLE_ACL,
    edges: t.members.map(m => edge(person(m.personId), docKey('team', t.id), 'member')),
    record: { subtitle: `Team · ${count}`, description: t.members.slice(0, 12).map(m => m.name).join(', '), href: `/iq/search?tab=results&type=person&q=${enc(t.name)}` },
  });
}

export function initiativeDoc(tenant: string, p: Pick<ProjectSummary, 'id' | 'name' | 'status' | 'ownerId' | 'ownerName' | 'lastActivityAt' | 'createdAt'>, summary: string | null | undefined, contributors: ProjectDetail['contributors']): SearchDoc {
  const edges = [
    ...(p.ownerId ? [edge(person(p.ownerId), initiative(p.id), 'owns')] : []),
    ...contributors.map(c => edge(person(c.personId), initiative(p.id), c.role?.toLowerCase() === 'sme' ? 'SME' : c.role === 'owner' ? 'owns' : 'contributes to')),
  ];
  return doc(tenant, 'initiative', p.id, {
    title: p.name, text: summary ?? '',
    facets: { status: [p.status ?? ''], owner: [p.ownerId ?? ''], sme: contributors.filter(c => c.role?.toLowerCase() === 'sme').map(c => c.personId) },
    people: [...(p.ownerId ? [p.ownerId] : []), ...contributors.map(c => c.personId)],
    edges, updatedAt: isoOrNull(p.lastActivityAt ?? p.createdAt),
    record: { description: summary ?? undefined, status: p.status ?? undefined, subtitle: p.ownerName ? `Owner: ${p.ownerName}` : undefined, href: `/iq/projects/${enc(p.id)}` },
  });
}

const CLOSED_WORK = new Set(['done', 'cancelled', 'closed', 'resolved']);
export function workDoc(tenant: string, w: WorkItem): SearchDoc {
  const blocked = !!w.blockedReason || !!w.labels?.includes('blocked');
  const ref = docKey('work', w.id);
  return doc(tenant, 'work', w.id, {
    title: w.title, text: `${w.summary ?? w.description ?? ''} ${[w.key, w.projectName].filter(Boolean).join(' ')}`,
    facets: { status: [blocked ? 'blocked' : '', w.status], open: [CLOSED_WORK.has(w.status) ? 'false' : 'true'], assignee: [w.assigneeId ?? ''], initiative: [w.projectId] },
    people: w.assigneeId ? [w.assigneeId] : [],
    edges: [
      edge(initiative(w.projectId), ref, 'includes'),
      ...(w.assigneeId ? [edge(person(w.assigneeId), ref, 'assigned to')] : []),
      ...(w.parentId ? [edge(docKey('work', w.parentId), ref, 'includes')] : []),
    ],
    updatedAt: isoOrNull(w.updatedAt),
    record: { description: w.summary ?? w.description ?? undefined, status: blocked ? 'blocked' : w.status, subtitle: [w.key, w.projectName, w.assigneeName].filter(Boolean).join(' · '), href: `/iq/projects/${enc(w.projectId)}?tab=work&item=${enc(w.id)}`, sourceRefs: [{ type: 'initiative', id: w.projectId }] },
  });
}

export function decisionDoc(tenant: string, d: DecisionDetail): SearchDoc {
  const ref = docKey('decision', d.id);
  const deciders = d.participants.filter(p => p.role === 'decider');
  return doc(tenant, 'decision', d.id, {
    title: d.topic, text: d.summary ?? '',
    facets: { status: [d.status], decider: deciders.map(p => p.personId), participant: d.participants.map(p => p.personId), initiative: [d.projectId ?? ''] },
    people: d.participants.map(p => p.personId),
    edges: [
      ...(d.projectId ? [edge(initiative(d.projectId), ref, 'decision')] : []),
      ...d.participants.map(p => edge(person(p.personId), ref, p.role ?? 'participates in')),
    ],
    updatedAt: isoOrNull(d.decidedAt),
    record: {
      description: d.summary ?? undefined, status: d.status,
      subtitle: deciders.length ? `Decided by ${deciders.map(p => p.name).join(', ')}` : undefined,
      href: `/iq/decisions/${enc(d.id)}`, sourceRefs: d.projectId ? [{ type: 'initiative', id: d.projectId }] : [],
    },
  });
}

export function designDoc(tenant: string, d: Pick<DesignReview, 'id' | 'title' | 'summary' | 'status' | 'orgProjectName' | 'orgProjectId' | 'updatedAt' | 'affected' | 'dependsOn'>): SearchDoc {
  const ref = docKey('decision', d.id);
  return doc(tenant, 'decision', d.id, {
    title: d.title, text: `${d.summary} Approved design ${d.orgProjectName}`,
    facets: { status: [d.status], initiative: [d.orgProjectId] },
    edges: [
      edge(initiative(d.orgProjectId), ref, 'approved decision'),
      ...d.affected.map(p => edge(ref, initiative(p.orgProjectId), 'affects')),
      ...d.dependsOn.map(id => edge(docKey('decision', id), ref, 'required by')),
    ],
    updatedAt: isoOrNull(d.updatedAt),
    record: { description: d.summary, status: d.status, subtitle: `Approved design · ${d.orgProjectName}`, href: `/iq/designs/${enc(d.id)}`, sourceRefs: [{ type: 'initiative', id: d.orgProjectId }] },
  });
}

export function knowledgeDoc(tenant: string, rb: RunbookSearchEntry): SearchDoc {
  const ref = docKey('knowledge', rb.id);
  const subtitle = `Runbook · v${rb.version}`;
  return doc(tenant, 'knowledge', rb.id, {
    title: rb.title, text: `${rb.summary} ${subtitle}`,
    facets: { level: ['runbook'], status: [rb.status], initiative: [rb.initiative_id ?? ''] },
    edges: rb.initiative_id ? [edge(initiative(rb.initiative_id), ref, 'scoped to')] : [],
    updatedAt: isoOrNull(rb.updated_at),
    record: {
      description: rb.summary, subtitle, status: rb.status,
      href: `/iq/runbooks/${enc(rb.id)}`,
      sourceRefs: rb.initiative_id ? [{ type: 'initiative', id: rb.initiative_id }] : [],
    },
  });
}

export function assetDoc(tenant: string, a: Pick<LibraryAsset, 'id' | 'name' | 'description' | 'lifecycleStatus' | 'kind' | 'usedBy' | 'updatedAt' | 'designReviewId'>): SearchDoc {
  const subtitle = `${a.kind} · ${a.usedBy.length ? a.usedBy.join(', ') : 'Not used yet'}`;
  return doc(tenant, 'asset', a.id, {
    title: a.name, text: `${a.description ?? ''} ${subtitle}`,
    facets: { status: [a.lifecycleStatus], kind: [a.kind] },
    edges: a.designReviewId ? [edge(docKey('decision', a.designReviewId), docKey('asset', a.id), 'ratifies')] : [],
    updatedAt: isoOrNull(a.updatedAt),
    record: { description: a.description, status: a.lifecycleStatus, subtitle, href: `/iq/library/${enc(a.id)}` },
  });
}

// ── the rebuild ──────────────────────────────────────────────────────────────

export interface OrgiqBuild {
  docs: SearchDoc[];
  /** Sources windowed or unreadable (search's `partial`). */
  partial: string[];
  /** True when a source failed outright: the build should be retried. */
  failed: boolean;
}

export async function buildOrgiqDocs(tenant: string): Promise<OrgiqBuild> {
  const partial: string[] = [];
  let failed = false;
  async function read<T>(name: string, promise: Promise<T>, fallback: T): Promise<T> {
    try { return await promise; } catch { partial.push(`${name} unavailable`); failed = true; return fallback; }
  }
  const [graph, teams, projects, work, decisions, designs, knowledge, assets] = await Promise.all([
    read('People', aurora.fetchGraph(), null),
    read('Teams', listOrgTeams(), []),
    read('Initiatives', listProjects({ limit: 200 }), []),
    read('Work', searchWorkItems({ limit: 200 }), []),
    read('Decisions', listDecisions({ limit: 200 }), []),
    read('Approved design decisions', listDesignReviews({ status: 'approved' }), []),
    read('Runbooks', listRunbookSearchEntries(), [] as RunbookSearchEntry[]),
    read('Agent library', listAssets({ limit: 200 }), { assets: [], total: 0, facets: { kind: {}, tier: {}, role: {} } }),
  ]);
  if (graph && graph.peopleTotal > graph.nodes.length) partial.push('People source window is limited');
  if (projects.length >= 200) partial.push('Initiatives source window is limited');
  if (work.length >= 200) partial.push('Work source window is limited');
  if (decisions.length >= 200) partial.push('Decisions source window is limited');
  if (assets.total > assets.assets.length) partial.push('Agent library source window is limited');
  const [summaries, details, decisionDetails] = await Promise.all([
    read('Initiative summaries', listProjectSummaries(projects.map(p => p.id)), new Map<string, string>()),
    Promise.all(projects.map(p => read('Initiative contributors', getProject(p.id), null))),
    Promise.all(decisions.map(d => read('Decision participants', getDecision(d.id), null))),
  ]);
  const docs: SearchDoc[] = [];
  const relationships = graph?.edges ?? [];
  graph?.nodes.forEach(p => docs.push(personDoc(tenant, p, relationships)));
  teams.forEach(t => docs.push(teamDoc(tenant, t)));
  projects.forEach((p, i) => docs.push(initiativeDoc(tenant, p, summaries.get(p.id) ?? details[i]?.summary ?? null, details[i]?.contributors ?? [])));
  work.forEach(w => docs.push(workDoc(tenant, w)));
  decisions.forEach((d, i) => docs.push(decisionDoc(tenant, decisionDetails[i] ?? { ...d, participants: [] })));
  const decisionIds = new Set(decisions.map(d => d.id));
  designs.forEach(d => {
    // Decisions (d-*) and designs (des-*) use distinct id namespaces; never overwrite one with the other.
    if (decisionIds.has(d.id)) { partial.push('Conflicting design decision ID'); return; }
    docs.push(designDoc(tenant, d));
  });
  knowledge.forEach(k => docs.push(knowledgeDoc(tenant, k)));
  assets.assets.forEach(a => docs.push(assetDoc(tenant, a)));
  return { docs, partial: [...new Set(partial)], failed };
}

// ── one record ───────────────────────────────────────────────────────────────

/** The doc for one record as its provider holds it now, or null when it no longer exists (or is not searchable). */
export async function projectOrgiqRecord(tenant: string, type: OrgiqDocType, id: string): Promise<SearchDoc | null> {
  switch (type) {
    case 'person': {
      const p = await aurora.fetchPersonGraph(id);
      return p ? personDoc(tenant, p, p.connections) : null;
    }
    case 'team': {
      const t = (await listOrgTeams()).find(x => x.id === id);
      return t ? teamDoc(tenant, t) : null;
    }
    case 'initiative': {
      const [summary, detail, summaries] = await Promise.all([
        listProjects({ limit: 200 }).then(ps => ps.find(p => p.id === id) ?? null),
        getProject(id),
        listProjectSummaries([id]),
      ]);
      if (!detail) return null;
      return initiativeDoc(tenant, summary ?? { ...detail, lastActivityAt: null }, summaries.get(id) ?? detail.summary, detail.contributors);
    }
    case 'work': {
      const w = await getWorkItem(id);
      return w ? workDoc(tenant, w) : null;
    }
    case 'decision': {
      const d = await getDecision(id);
      if (d) return decisionDoc(tenant, d);
      const design = await getDesignThread(id);
      return design?.status === 'approved' ? designDoc(tenant, design) : null;
    }
    case 'knowledge': {
      const k = await getRunbookSearchEntry(id);
      return k ? knowledgeDoc(tenant, k) : null;
    }
    case 'asset': {
      const a = await getAsset(id);
      return a ? assetDoc(tenant, a) : null;
    }
  }
}

// Search projects existing records into one read model; it never creates content.
// Authorization is applied before records, counts, or graph edges are exposed.
import { AppError } from '../lib/async-handler.js';
import { isAllowed, type PrincipalRef } from '../lib/authz.js';
import { aurora } from './index.js';
import { listProjects, listProjectSummaries, getProject } from './projects.js';
import { searchWorkItems, getWorkItem } from './work-items.js';
import { listDesignReviews, getDesignThread, type DesignReview } from './design-reviews.js';
import { listDecisions, getDecision } from './decisions.js';
import { listItems, getItem, type DistillationItem } from './distillation.js';
import { listAssets, getAsset } from './prompt-library.js';
import { listRecordingSearchRecords, resolveRecordingSearchRecord, type RecordingSearchRecord } from './recording-search.js';

export const SEARCH_TYPES = ['person', 'initiative', 'work', 'decision', 'knowledge', 'asset', 'recording'] as const;
export type SearchRecordType = typeof SEARCH_TYPES[number];
export interface SearchRef { type: SearchRecordType; id: string }
export interface SearchRecord extends SearchRef {
  title: string; description?: string; href: string; status?: string; subtitle?: string;
  /** Existing authorized people portrait; no generated or inferred face. */
  avatarUrl?: string;
  sourceRefs?: SearchRef[];
  /** ISO time the source last changed, only where the source records one. */
  updatedAt?: string;
  /** Why this row scored: one of MATCH_REASONS. Absent with no query and no scope. */
  matchReason?: MatchReason;
  /** Query terms (after stopwords) found in title/description/subtitle, in query order. */
  highlights?: string[];
}
export const SEARCH_SORTS = ['relevance', 'recent'] as const;
export type SearchSort = typeof SEARCH_SORTS[number];
export const MATCH_REASONS = {
  title: 'Title match',
  text: 'Text match',
  membership: 'Matched through initiative membership',
  work: 'Matched through initiative work',
  linked: 'Matched through a linked initiative',
  scope: 'In scope',
} as const;
export type MatchReason = typeof MATCH_REASONS[keyof typeof MATCH_REASONS];
export interface SearchEdge { id: string; source: string; target: string; label: string }
export interface SearchResponse {
  query: string; results: SearchRecord[]; counts: Record<SearchRecordType | 'all', number>;
  total: number;
  /**
   * True when `total` and `counts` are floors, not exact: every source is read
   * through a bounded window (initiatives/work/decisions/assets 200, knowledge
   * 1000, the people graph's own cap), and a full window — or a source that
   * failed to read, or a dropped conflicting row — means rows existed that were
   * never scored. `partial` names which source caused it.
   */
  totalIsLowerBound: boolean;
  related: SearchRecord[]; edges: SearchEdge[]; partial?: string[];
}
export interface SearchOptions { q?: string; type?: SearchRecordType | 'all'; scope?: string; limit?: number; offset?: number; sort?: SearchSort }
export const searchKey = (ref: SearchRef): string => `${ref.type}:${ref.id}`;
const enc = encodeURIComponent;
const STOPWORDS = new Set('a an and are as at be by can could do does for from has have help how i in is it me my of on or our please should that the their them there these they this to us was we what when where which who why will with would you your finish find show about'.split(' '));
function terms(q: string): string[] { return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(t => !STOPWORDS.has(t)); }
function score(record: SearchRecord, tokens: string[]): number {
  if (!tokens.length) return 1;
  const title = record.title.toLowerCase();
  const text = textOf(record);
  const hits = tokens.filter(t => text.includes(t));
  return hits.length ? hits.length * 2 + tokens.filter(t => title.includes(t)).length * 4 + (tokens.every(t => title.includes(t)) ? 12 : 0) : 0;
}
const textOf = (record: RecordingSearchRecord): string => `${record.title} ${record.searchText ?? record.description ?? ''} ${record.subtitle ?? ''}`.toLowerCase();
function publicRecord(record: RecordingSearchRecord, tokens: string[] = []): SearchRecord {
  const { searchText, ...visible } = record;
  if (!searchText) return visible;
  // Match the whole bounded native artifact, but return only a useful excerpt.
  const firstHit = tokens.map(t => searchText.toLowerCase().indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 160);
  return { ...visible, description: `${start ? '…' : ''}${searchText.slice(start, start + 1200)}${start + 1200 < searchText.length ? '…' : ''}` };
}
/** Search only an already-authorized bounded recording projection. Assessment
 * uses its own ViewAssessment gate; this performs no Work-domain reads. */
export function recordingSearchResponse(projection: { records: RecordingSearchRecord[]; partial: string[] }, opts: SearchOptions): SearchResponse {
  const tokens = terms(opts.q ?? '');
  const scores = new Map(projection.records.map(record => [record.id, score(record, tokens)]));
  const relevance = (a: SearchRecord, b: SearchRecord) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  const recent = (a: SearchRecord, b: SearchRecord) => (a.updatedAt && b.updatedAt ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt ? -1 : b.updatedAt ? 1 : 0) || relevance(a, b);
  const matches = projection.records.filter(record => (scores.get(record.id) ?? 0) > 0).sort(opts.sort === 'recent' ? recent : relevance);
  const counts = Object.fromEntries([...SEARCH_TYPES, 'all'].map(type => [type, type === 'recording' || type === 'all' ? matches.length : 0])) as SearchResponse['counts'];
  return { query: opts.q ?? '', results: matches.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50)).map(record => {
    const reason = textReason(record, tokens);
    return { ...publicRecord(record, tokens), ...(reason ? { matchReason: reason } : {}), ...(tokens.length ? { highlights: tokens.filter(token => textOf(record).includes(token)) } : {}) };
  }), total: matches.length, counts, totalIsLowerBound: projection.partial.length > 0, related: [], edges: [], ...(projection.partial.length ? { partial: projection.partial } : {}) };
}
/** The text half of score(): which part of the record the query hit. */
function textReason(record: SearchRecord, tokens: string[]): MatchReason | undefined {
  if (!tokens.length) return undefined;
  const title = record.title.toLowerCase();
  if (tokens.some(t => title.includes(t))) return MATCH_REASONS.title;
  const text = textOf(record);
  return tokens.some(t => text.includes(t)) ? MATCH_REASONS.text : undefined;
}
/** Normalise a source timestamp to ISO; a zone-less string is UTC (Aurora's naive TIMESTAMPTZ). Never invents one. */
function isoOrUndefined(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const isoish = text.includes('T') ? text : text.replace(' ', 'T');
  const d = new Date(hasZone ? isoish : `${isoish}Z`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}
async function permissions(principal: PrincipalRef): Promise<{ people: boolean }> {
  if ((principal.tenant !== 'orgiq' && principal.role !== 'admin') || !(await isAllowed(principal, 'Search'))) {
    throw new AppError(403, 'Search is not permitted');
  }
  return { people: await isAllowed(principal, 'ViewOrgChart') };
}
function knowledgeRecord(item: DistillationItem): SearchRecord {
  const artifact = item.level === 'L2';
  return { id: item.id, type: 'knowledge', title: item.title,
    description: 'summary' in item ? item.summary : item.body,
    href: `/iq/distillation/knowledge?view=${artifact ? 'guides' : item.level === 'L1' ? 'patterns' : 'notes'}&item=${enc(item.id)}`,
    subtitle: artifact ? item.type : item.level === 'L1' ? 'Pattern' : 'Observation',
    ...('status' in item ? { status: item.status } : {}),
    updatedAt: isoOrUndefined(item.level === 'L0' ? item.created_at : item.updated_at),
    sourceRefs: 'initiative_id' in item ? [{ type: 'initiative', id: item.initiative_id }] : [],
  };
}

function designRecord(d: DesignReview): SearchRecord {
  return { type: 'decision', id: d.id, title: d.title, description: d.summary, status: d.status,
    subtitle: `Approved design · ${d.orgProjectName}`, href: `/iq/designs/${enc(d.id)}`, updatedAt: isoOrUndefined(d.updatedAt),
    sourceRefs: [{ type: 'initiative', id: d.orgProjectId }] };
}

export async function searchRecords(principal: PrincipalRef, opts: SearchOptions = {}): Promise<SearchResponse> {
  const allowed = await permissions(principal);
  const partial: string[] = [];
  async function read<T>(name: string, promise: Promise<T>, fallback: T): Promise<T> {
    try { return await promise; } catch { partial.push(`${name} unavailable`); return fallback; }
  }
  const [graph, projects, work, decisions, designs, knowledge, assets, recordings] = await Promise.all([
    allowed.people ? read('People', aurora.fetchGraph(), null) : Promise.resolve(null),
    read('Initiatives', listProjects({ limit: 200 }), []),
    read('Work', searchWorkItems({ limit: 200 }), []),
    read('Decisions', listDecisions({ limit: 200 }), []),
    read('Approved design decisions', listDesignReviews({ status: 'approved' }), []),
    read('Knowledge', listItems({ limit: 1000 }), { items: [], total: 0, next_cursor: null }),
    read('Agent library', listAssets({ limit: 200 }), { assets: [], total: 0, facets: { kind: {}, tier: {}, role: {} } }),
    read('Recordings', listRecordingSearchRecords(principal, opts.scope), { records: [], partial: [] }),
  ]);
  partial.push(...recordings.partial);
  if (graph && graph.peopleTotal > graph.nodes.length) partial.push('People source window is limited');
  if (projects.length >= 200) partial.push('Initiatives source window is limited');
  if (work.length >= 200) partial.push('Work source window is limited');
  if (decisions.length >= 200) partial.push('Decisions source window is limited');
  if (knowledge.total > knowledge.items.length) partial.push('Knowledge source window is limited');
  if (assets.total > assets.assets.length) partial.push('Agent library source window is limited');
  // Initiative prose is scored for every initiative, scoped or not, so widening
  // the scope can never drop a summary match. One batched read, not one per row.
  const summaries = await read('Initiative summaries', listProjectSummaries(projects.map(p => p.id)), new Map<string, string>());
  const records = new Map<string, RecordingSearchRecord>();
  const edges: SearchEdge[] = [];
  const add = (record: RecordingSearchRecord) => records.set(searchKey(record), record);
  const edge = (source: SearchRef, target: SearchRef, label: string) => {
    const from = searchKey(source), to = searchKey(target);
    edges.push({ id: `${from}:${label}:${to}`, source: from, target: to, label });
  };
  const person = (id: string): SearchRef => ({ type: 'person', id });
  const initiative = (id: string): SearchRef => ({ type: 'initiative', id });
  graph?.nodes.forEach(p => add({ type: 'person', id: p.id, title: p.name, description: p.skills.join(', '), subtitle: [p.title, p.department].filter(Boolean).join(' · '), ...(p.avatarUrl?.trim() ? { avatarUrl: p.avatarUrl } : {}), href: `/iq/search?tab=connections&selection=${enc(`person:${p.id}`)}` }));
  projects.forEach(p => {
    add({ type: 'initiative', id: p.id, title: p.name, description: summaries.get(p.id), status: p.status ?? undefined, subtitle: p.ownerName ? `Owner: ${p.ownerName}` : undefined, href: `/iq/projects/${enc(p.id)}`, updatedAt: isoOrUndefined(p.lastActivityAt ?? p.createdAt) });
    if (p.ownerId) edge(person(p.ownerId), initiative(p.id), 'owns');
  });
  work.forEach(w => {
    const ref: SearchRef = { type: 'work', id: w.id };
    add({ ...ref, title: w.title, description: w.summary ?? w.description ?? undefined, status: w.blockedReason || w.labels?.includes('blocked') ? 'blocked' : w.status, subtitle: [w.key, w.projectName, w.assigneeName].filter(Boolean).join(' · '), href: `/iq/projects/${enc(w.projectId)}?tab=work&item=${enc(w.id)}`, sourceRefs: [initiative(w.projectId)], updatedAt: isoOrUndefined(w.updatedAt) });
    edge(initiative(w.projectId), ref, 'includes');
    if (w.assigneeId) edge(person(w.assigneeId), ref, 'assigned to');
    if (w.parentId) edge({ type: 'work', id: w.parentId }, ref, 'includes');
  });
  decisions.forEach(d => {
    const ref: SearchRef = { type: 'decision', id: d.id };
    add({ ...ref, title: d.topic, description: d.summary ?? undefined, status: d.status, href: d.projectId ? `/iq/projects/${enc(d.projectId)}?tab=decisions&decision=${enc(d.id)}` : `/iq/search?type=decision&q=${enc(d.topic)}`, sourceRefs: d.projectId ? [initiative(d.projectId)] : [], updatedAt: isoOrUndefined(d.decidedAt) });
    if (d.projectId) edge(initiative(d.projectId), ref, 'decision');
  });
  designs.forEach(d => {
    // The domains use distinct canonical ID namespaces (d-* and des-*).
    // Never silently overwrite a decision if an upstream violates that rule.
    if (records.has(`decision:${d.id}`)) { partial.push('Conflicting design decision ID'); return; }
    const record = designRecord(d); add(record);
    edge(initiative(d.orgProjectId), record, 'approved decision');
    d.affected.forEach(p => edge(record, initiative(p.orgProjectId), 'affects'));
    d.dependsOn.forEach(id => edge({ type: 'decision', id }, record, 'required by'));
  });
  knowledge.items.forEach(k => {
    const record = knowledgeRecord(k); add(record);
    if ('initiative_id' in k) edge(initiative(k.initiative_id), record, 'evidence');
    if (k.level === 'L1') k.member_observation_ids.forEach(id => edge({ type: 'knowledge', id }, record, 'supports'));
    if (k.level === 'L2') {
      k.cluster_ids.forEach(id => edge({ type: 'knowledge', id }, record, 'distilled into'));
      if (k.library_item_id) edge(record, { type: 'asset', id: k.library_item_id }, 'derived asset');
    }
  });
  assets.assets.forEach(a => add({ type: 'asset', id: a.id, title: a.name, description: a.description, status: a.lifecycleStatus, subtitle: `${a.kind} · ${a.usedBy.length ? a.usedBy.join(', ') : 'Not used yet'}`, href: `/iq/library/${enc(a.id)}`, updatedAt: isoOrUndefined(a.updatedAt) }));
  assets.assets.forEach(a => { if (a.designReviewId) edge({ type: 'decision', id: a.designReviewId }, { type: 'asset', id: a.id }, 'ratifies'); });
  recordings.records.forEach(record => {
    add(record);
    record.sourceRefs?.forEach(source => edge(source, record, 'recorded artifacts'));
  });
  // Only load contribution roles for relevant initiatives, rather than issuing
  // a detail query per catalog row. Owners are already authoritative above.
  const tokens = terms(opts.q ?? '');
  const matchingProjects = projects.filter(p => opts.scope ? p.id === opts.scope : tokens.length > 0 && tokens.every(t => p.name.toLowerCase().includes(t))).slice(0, 12);
  await Promise.all(matchingProjects.map(async p => {
    const detail = await read('Initiative contributors', getProject(p.id), null);
    if (!detail) return;
    const record = records.get(searchKey(initiative(p.id)));
    // Fallback only: the batched summary read above is the primary source.
    if (record && !record.description && detail.summary) record.description = detail.summary;
    if (allowed.people) detail.contributors.forEach(c => edge(person(c.personId), initiative(p.id), c.role?.toLowerCase() === 'sme' ? 'SME' : c.role === 'owner' ? 'owns' : 'contributes to'));
  }));
  const validEdges = [...new Map(edges.filter(e => records.has(e.source) && records.has(e.target)).map(e => [e.id, e])).values()];
  const scoped = new Set<string>();
  if (opts.scope) {
    const root = searchKey(initiative(opts.scope)); scoped.add(root);
    // Follow evidence descendants and direct people links, not every initiative
    // a selected person participates in.
    for (let pass = 0; pass < 4; pass++) validEdges.forEach(e => {
      if (scoped.has(e.source) && !e.target.startsWith('initiative:')) scoped.add(e.target);
      if (scoped.has(e.target) && e.source.startsWith('person:')) scoped.add(e.source);
    });
  }
  const available = [...records.values()].filter(r => !opts.scope || scoped.has(searchKey(r)));
  const scores = new Map(available.map(r => [searchKey(r), score(r, tokens)]));
  // The reason a row scored is whichever component set its final score.
  const reasons = new Map<string, MatchReason | undefined>(available.map(r => [searchKey(r), tokens.length ? textReason(r, tokens) : opts.scope ? MATCH_REASONS.scope : undefined]));
  const lift = (key: string, value: number, reason: MatchReason) => {
    if (value <= (scores.get(key) ?? 0)) return;
    scores.set(key, value);
    // Without a query every scoped row is simply in scope; edges only reorder them.
    if (tokens.length) reasons.set(key, reason);
  };
  // A named initiative is also a query for its recorded owners, contributors,
  // and work. Expansion follows real edges, never string-matched identities.
  const roots = new Set(matchingProjects.filter(p => !tokens.length || tokens.every(t => p.name.toLowerCase().includes(t))).map(p => searchKey(initiative(p.id))));
  validEdges.forEach(e => {
    if (roots.has(e.source) && scores.has(e.target)) {
      const isWork = e.target.startsWith('work:') && e.label === 'includes';
      lift(e.target, e.target.startsWith('work:') ? (records.get(e.target)?.status === 'blocked' ? 18 : ['done', 'cancelled'].includes(records.get(e.target)?.status ?? '') ? 2 : 14) : 5, isWork ? MATCH_REASONS.work : MATCH_REASONS.linked);
    }
    if (roots.has(e.target) && scores.has(e.source)) {
      const isPerson = e.source.startsWith('person:');
      lift(e.source, isPerson ? (e.label === 'owns' ? 22 : 20) : 5, isPerson ? MATCH_REASONS.membership : MATCH_REASONS.linked);
    }
  });
  const byRelevance = (a: SearchRecord, b: SearchRecord) => (scores.get(searchKey(b)) ?? 0) - (scores.get(searchKey(a)) ?? 0) || a.title.localeCompare(b.title) || searchKey(a).localeCompare(searchKey(b));
  // Recent: newest recorded change first; rows whose source records no time
  // follow all dated rows; relevance breaks ties. Nothing is backfilled.
  const byRecent = (a: SearchRecord, b: SearchRecord) => (a.updatedAt && b.updatedAt ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt ? -1 : b.updatedAt ? 1 : 0) || byRelevance(a, b);
  const annotate = (r: SearchRecord): SearchRecord => {
    const reason = reasons.get(searchKey(r));
    if (!tokens.length) return reason ? { ...publicRecord(r), matchReason: reason } : publicRecord(r);
    const text = textOf(r);
    return { ...publicRecord(r, tokens), ...(reason ? { matchReason: reason } : {}), highlights: tokens.filter(t => text.includes(t)) };
  };
  const matches = available.filter(r => (scores.get(searchKey(r)) ?? 0) > 0).sort(opts.sort === 'recent' ? byRecent : byRelevance).map(annotate);
  const counts = { all: matches.length, person: 0, initiative: 0, work: 0, decision: 0, knowledge: 0, asset: 0, recording: 0 };
  matches.forEach(r => counts[r.type]++);
  const filtered = matches.filter(r => !opts.type || opts.type === 'all' || r.type === opts.type);
  const results = filtered.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
  const visible = new Set(results.map(searchKey));
  const neighbors = new Set<string>();
  validEdges.forEach(e => { if (visible.has(e.source)) neighbors.add(e.target); if (visible.has(e.target)) neighbors.add(e.source); });
  const related = available.filter(r => neighbors.has(searchKey(r)) && !visible.has(searchKey(r))).slice(0, 100).map(r => (scores.get(searchKey(r)) ?? 0) > 0 ? annotate(r) : publicRecord(r));
  related.forEach(r => visible.add(searchKey(r)));
  // `total` is the requested type's match count — the same number its tab
  // badge shows — counted over the records the bounded source reads returned.
  // Any partial read makes it (and every count) a floor, and the response says so.
  const total = counts[!opts.type || opts.type === 'all' ? 'all' : opts.type];
  return { query: opts.q ?? '', results, counts, total, totalIsLowerBound: partial.length > 0, related, edges: validEdges.filter(e => visible.has(e.source) && visible.has(e.target)), ...(partial.length ? { partial: [...new Set(partial)] } : {}) };
}

/** Resolve context afresh on the server; client titles and URLs are never trusted. */
export async function resolveSearchRecords(principal: PrincipalRef, refs: SearchRef[]): Promise<SearchRecord[]> {
  const allowed = await permissions(principal);
  const distinct = [...new Map(refs.slice(0, 30).map(r => [searchKey(r), r])).values()];
  const resolved = await Promise.all(distinct.map(async ref => {
    if (ref.type === 'person') {
      if (!allowed.people) return null;
      const p = await aurora.fetchPersonGraph(ref.id);
      return p ? { ...ref, title: p.name, subtitle: [p.title, p.department].filter(Boolean).join(' · '), ...(p.avatarUrl?.trim() ? { avatarUrl: p.avatarUrl } : {}), href: `/iq/search?tab=connections&selection=${enc(searchKey(ref))}` } : null;
    }
    if (ref.type === 'initiative') {
      const p = await getProject(ref.id);
      return p ? { ...ref, title: p.name, description: p.summary ?? undefined, subtitle: [p.ownerName ? `Owner: ${p.ownerName}` : '', ...p.contributors.map(c => `${c.name}: ${c.role ?? 'contributor'}`)].filter(Boolean).join('; '), status: p.status ?? undefined, href: `/iq/projects/${enc(p.id)}` } : null;
    }
    if (ref.type === 'work') {
      const w = await getWorkItem(ref.id);
      return w ? { ...ref, title: w.title, description: w.description ?? w.summary ?? undefined, subtitle: w.assigneeName ?? undefined, status: w.blockedReason || w.labels?.includes('blocked') ? 'blocked' : w.status, href: `/iq/projects/${enc(w.projectId)}?tab=work&item=${enc(w.id)}`, sourceRefs: [{ type: 'initiative' as const, id: w.projectId }] } : null;
    }
    if (ref.type === 'decision') {
      const d = await getDecision(ref.id);
      if (!d) { const design = await getDesignThread(ref.id); return design?.status === 'approved' ? designRecord(design) : null; }
      return d ? { ...ref, title: d.topic, description: d.summary ?? undefined, status: d.status, href: d.projectId ? `/iq/projects/${enc(d.projectId)}?tab=decisions&decision=${enc(d.id)}` : `/iq/search?type=decision&q=${enc(d.topic)}` } : null;
    }
    if (ref.type === 'knowledge') { const k = await getItem(ref.id); return k ? knowledgeRecord(k) : null; }
    if (ref.type === 'asset') { const a = await getAsset(ref.id); return a ? { ...ref, title: a.name, description: a.description, status: a.lifecycleStatus, href: `/iq/library/${enc(a.id)}` } : null; }
    if (ref.type === 'recording') return resolveRecordingSearchRecord(principal, ref.id);
    return null;
  }));
  return resolved.filter((r): r is NonNullable<typeof r> => r !== null);
}

/** Relationships among the selected context records, using their source IDs. */
export async function resolveSearchContext(principal: PrincipalRef, refs: SearchRef[]): Promise<{ records: SearchRecord[]; edges: SearchEdge[] }> {
  const records = await resolveSearchRecords(principal, refs);
  const keys = new Set(records.map(searchKey));
  const edges: SearchEdge[] = [];
  const link = (source: SearchRef, target: SearchRef, label: string) => {
    const from = searchKey(source), to = searchKey(target);
    if (keys.has(from) && keys.has(to)) edges.push({ id: `${from}:${label}:${to}`, source: from, target: to, label });
  };
  await Promise.all(records.map(async record => {
    if (record.type === 'initiative') {
      const p = await getProject(record.id);
      if (p?.ownerId) link({ type: 'person', id: p.ownerId }, record, 'owns');
      p?.contributors.forEach(c => link({ type: 'person', id: c.personId }, record, c.role?.toLowerCase() === 'sme' ? 'SME' : c.role === 'owner' ? 'owns' : 'contributes to'));
    } else if (record.type === 'work') {
      const w = await getWorkItem(record.id);
      if (w) {
        link({ type: 'initiative', id: w.projectId }, record, 'includes');
        if (w.assigneeId) link({ type: 'person', id: w.assigneeId }, record, 'assigned to');
        if (w.parentId) link({ type: 'work', id: w.parentId }, record, 'includes');
      }
    } else if (record.type === 'decision') {
      const d = await getDecision(record.id);
      if (d?.projectId) link({ type: 'initiative', id: d.projectId }, record, 'decision');
      if (!d) {
        const design = await getDesignThread(record.id);
        if (design?.status === 'approved') {
          link({ type: 'initiative', id: design.orgProjectId }, record, 'approved decision');
          design.dependsOn.forEach(id => link({ type: 'decision', id }, record, 'required by'));
        }
      }
      d?.participants.forEach(p => link({ type: 'person', id: p.personId }, record, p.role ?? 'participates in'));
    } else if (record.type === 'asset') {
      const asset = await getAsset(record.id);
      if (asset?.designReviewId) link({ type: 'decision', id: asset.designReviewId }, record, 'ratifies');
    } else if (record.type === 'knowledge') {
      const k = await getItem(record.id);
      if (!k) return;
      if ('initiative_id' in k) link({ type: 'initiative', id: k.initiative_id }, record, 'evidence');
      if (k.level === 'L1') k.member_observation_ids.forEach(id => link({ type: 'knowledge', id }, record, 'supports'));
      if (k.level === 'L2') {
        k.cluster_ids.forEach(id => link({ type: 'knowledge', id }, record, 'distilled into'));
        if (k.library_item_id) link(record, { type: 'asset', id: k.library_item_id }, 'derived asset');
      }
    } else if (record.type === 'recording') {
      record.sourceRefs?.forEach(source => link(source, record, 'recorded artifacts'));
    }
  }));
  return { records, edges: [...new Map(edges.map(e => [e.id, e])).values()] };
}

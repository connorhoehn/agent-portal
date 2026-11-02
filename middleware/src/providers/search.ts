// Search projects existing records into one read model; it never creates content.
// Authorization is applied before records, counts, or graph edges are exposed.
import { AppError } from '../lib/async-handler.js';
import { isAllowed, type PrincipalRef } from '../lib/authz.js';
import { aurora } from './index.js';
import { getProject } from './projects.js';
import { getWorkItem } from './work-items.js';
import { getDesignThread, type DesignReview } from './design-reviews.js';
import { getDecision } from './decisions.js';
import { getRunbookSearchEntry, type RunbookSearchEntry } from '../lib/runbooks/search-entries.js';
import { getAsset } from './prompt-library.js';
import { listRecordingSearchRecords, resolveRecordingSearchRecord, type RecordingSearchRecord } from './recording-search.js';
import { ensureIndexed } from '../lib/search-index/registry.js';
import { PEOPLE_ACL, projectOrgiqRecord } from '../lib/search-index/orgiq.js';
import { parseQuestion, STOPWORDS, type ParsedQuestion } from '../lib/search-index/question.js';
import { resolveQuestion, vocabulary, type AnswerReason, type ResolveContext } from '../lib/search-index/resolve.js';
import type { SearchDoc } from '../lib/search-index/types.js';
import { mineViewer } from '../lib/mine.js';
import type { Session } from '../lib/session.js';

export const SEARCH_TYPES = ['person', 'team', 'initiative', 'work', 'decision', 'knowledge', 'asset', 'recording'] as const;
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
/** Why a row scored: a text reason, an edge reason, or the question intent it answers (lib/search-index/resolve.ts). */
export type MatchReason = typeof MATCH_REASONS[keyof typeof MATCH_REASONS] | AnswerReason;
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
function knowledgeRecord(rb: RunbookSearchEntry): SearchRecord {
  return { id: rb.id, type: 'knowledge', title: rb.title, description: rb.summary,
    href: `/iq/runbooks/${enc(rb.id)}`, subtitle: `Runbook · v${rb.version}`, status: rb.status,
    updatedAt: isoOrUndefined(rb.updated_at),
    sourceRefs: rb.initiative_id ? [{ type: 'initiative', id: rb.initiative_id }] : [],
  };
}

function designRecord(d: DesignReview): SearchRecord {
  return { type: 'decision', id: d.id, title: d.title, description: d.summary, status: d.status,
    subtitle: `Approved design · ${d.orgProjectName}`, href: `/iq/designs/${enc(d.id)}`, updatedAt: isoOrUndefined(d.updatedAt),
    sourceRefs: [{ type: 'initiative', id: d.orgProjectId }] };
}

export async function searchRecords(principal: PrincipalRef, opts: SearchOptions = {}): Promise<SearchResponse> {
  const allowed = await permissions(principal);
  const allowedAcls = allowed.people ? [PEOPLE_ACL] : [];
  const partial: string[] = [];
  // The projection (lib/search-index) holds every orgiq record type but one:
  // recordings are participant-private and resolved per reader, so they are
  // still read live here.
  const [indexed, recordings] = await Promise.all([
    ensureIndexed('orgiq').catch(() => { partial.push('Search index unavailable'); return null; }),
    listRecordingSearchRecords(principal, opts.scope).catch(() => { partial.push('Recordings unavailable'); return { records: [], partial: [] }; }),
  ]);
  partial.push(...(indexed?.meta.partial ?? []), ...recordings.partial);
  const q = opts.q ?? '';
  const index = indexed?.index ?? null, tenant = indexed?.partition ?? '';
  const ctx: ResolveContext | null = index ? { index, partition: tenant, allowedAcls, personId: null } : null;
  // U7: the question is rewritten before it is searched — scaffolding out,
  // synonyms in, "my/me" bound to the signed-in person (U6), structured intents named.
  const parsed: ParsedQuestion = q.trim() && ctx ? parseQuestion(q, await vocabulary(ctx)) : { terms: plainTerms(q), intents: [], mine: false };
  const tokens = parsed.terms.map(t => t.toLowerCase());
  if (ctx && parsed.intents.some(i => i.kind === 'my-work')) ctx.personId = await viewerPersonId(principal);

  const docs = new Map<string, SearchDoc>();
  const keep = (d: SearchDoc) => { if (d.acl == null || allowedAcls.includes(d.acl)) docs.set(searchKey(d as unknown as SearchRef), d); };
  if (index) {
    if (tokens.length) (await index.query({ tenant, terms: tokens, allowedAcls })).docs.forEach(keep);
    else if (!q.trim() || opts.scope) (await index.query({ tenant, terms: [], allowedAcls })).docs.forEach(keep);
  }
  // Scope: the initiative and what hangs off it — evidence descendants and
  // direct people links, not every initiative a selected person is on.
  const scoped = new Set<string>();
  if (opts.scope && index) {
    const root = searchKey(initiative(opts.scope)); scoped.add(root);
    (await index.get(tenant, [root])).forEach(keep);
    let frontier = [root];
    for (let pass = 0; pass < 4 && frontier.length; pass++) {
      const next: string[] = [];
      for (const n of await index.neighbours(tenant, frontier)) {
        const other = n.edge.source === n.from ? n.edge.target : n.edge.source;
        const follows = n.edge.source === n.from ? !other.startsWith('initiative:') : other.startsWith('person:');
        if (follows && !scoped.has(other)) {
          scoped.add(other); keep(n.doc);
          // People belong in the scope, but are terminal: following their
          // assignments/collaborations pulls in unrelated initiatives' work.
          if (!other.startsWith('person:')) next.push(other);
        }
      }
      frontier = next;
    }
    // Recordings are read live, not projected: they join the scope through their own source links.
    recordings.records.forEach(r => { if (r.sourceRefs?.some(ref => scoped.has(searchKey(ref)))) scoped.add(searchKey(r)); });
  }
  // A named initiative is also a query for its recorded owners, contributors
  // and work. Expansion follows real edges, never string-matched identities.
  const namesAll = (d: SearchDoc) => tokens.every(t => d.title.toLowerCase().includes(t));
  const roots = [...docs.values()].filter(d => d.type === 'initiative' && (opts.scope ? d.id === opts.scope && namesAll(d) : tokens.length > 0 && namesAll(d))).slice(0, 12).map(d => searchKey(d as unknown as SearchRef));
  const rootEdges = index && roots.length ? await index.neighbours(tenant, roots) : [];
  rootEdges.forEach(n => keep(n.doc));
  const resolutions = ctx ? await resolveQuestion(parsed, ctx) : [];
  resolutions.forEach(r => r.hits.forEach(h => keep(h.doc)));

  const records = new Map<string, RecordingSearchRecord>();
  const text = new Map<string, string>();
  const edges: SearchEdge[] = [];
  for (const d of docs.values()) {
    const key = searchKey(d as unknown as SearchRef);
    records.set(key, docRecord(d));
    text.set(key, `${d.title} ${d.text}`.toLowerCase());
    edges.push(...d.edges.map(e => ({ id: e.id, source: e.source, target: e.target, label: e.label })));
  }
  rootEdges.forEach(n => edges.push({ id: n.edge.id, source: n.edge.source, target: n.edge.target, label: n.edge.label }));
  recordings.records.forEach(record => {
    const key = searchKey(record);
    records.set(key, record); text.set(key, textOf(record));
    record.sourceRefs?.forEach(source => { const from = searchKey(source); edges.push({ id: `${from}:recorded artifacts:${key}`, source: from, target: key, label: 'recorded artifacts' }); });
  });
  const validEdges = [...new Map(edges.filter(e => records.has(e.source) && records.has(e.target)).map(e => [e.id, e])).values()];
  const available = [...records.values()].filter(r => !opts.scope || scoped.has(searchKey(r)));
  const textFor = (r: SearchRecord) => text.get(searchKey(r)) ?? textOf(r);
  const scoreOf = (r: SearchRecord): number => {
    if (!tokens.length) return parsed.intents.length ? 0 : 1;
    const title = r.title.toLowerCase(), body = textFor(r);
    const hits = tokens.filter(t => body.includes(t));
    return hits.length ? hits.length * 2 + tokens.filter(t => title.includes(t)).length * 4 + (tokens.every(t => title.includes(t)) ? 12 : 0) : 0;
  };
  const reasonOf = (r: SearchRecord): MatchReason | undefined => {
    if (!tokens.length) return undefined;
    if (tokens.some(t => r.title.toLowerCase().includes(t))) return MATCH_REASONS.title;
    return tokens.some(t => textFor(r).includes(t)) ? MATCH_REASONS.text : undefined;
  };
  const scores = new Map(available.map(r => [searchKey(r), scoreOf(r)]));
  const reasons = new Map<string, MatchReason | undefined>(available.map(r => [searchKey(r), tokens.length ? reasonOf(r) : opts.scope ? MATCH_REASONS.scope : undefined]));
  const lift = (key: string, value: number, reason: MatchReason) => {
    if (!scores.has(key) || value <= (scores.get(key) ?? 0)) return;
    scores.set(key, value);
    // Without a query every scoped row is simply in scope; edges only reorder them.
    if (tokens.length || parsed.intents.length) reasons.set(key, reason);
  };
  const rootSet = new Set(roots);
  rootEdges.forEach(({ edge: e }) => {
    if (rootSet.has(e.source)) {
      const status = records.get(e.target)?.status ?? '';
      const isWork = e.target.startsWith('work:') && e.label === 'includes';
      lift(e.target, e.target.startsWith('work:') ? (status === 'blocked' ? 18 : ['done', 'cancelled'].includes(status) ? 2 : 14) : 5, isWork ? MATCH_REASONS.work : MATCH_REASONS.linked);
    }
    if (rootSet.has(e.target)) {
      const isPerson = e.source.startsWith('person:');
      lift(e.source, isPerson ? (e.label === 'owns' ? 22 : 20) : 5, isPerson ? MATCH_REASONS.membership : MATCH_REASONS.linked);
    }
  });
  // The records that answer the question outrank the words that merely appear in it.
  resolutions.forEach(r => r.hits.forEach(h => lift(searchKey(h.doc as unknown as SearchRef), 100 + h.score, h.reason)));

  const byRelevance = (a: SearchRecord, b: SearchRecord) => (scores.get(searchKey(b)) ?? 0) - (scores.get(searchKey(a)) ?? 0) || a.title.localeCompare(b.title) || searchKey(a).localeCompare(searchKey(b));
  // Recent: newest recorded change first; rows whose source records no time
  // follow all dated rows; relevance breaks ties. Nothing is backfilled.
  const byRecent = (a: SearchRecord, b: SearchRecord) => (a.updatedAt && b.updatedAt ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt ? -1 : b.updatedAt ? 1 : 0) || byRelevance(a, b);
  const annotate = (r: RecordingSearchRecord): SearchRecord => {
    const reason = reasons.get(searchKey(r));
    if (!tokens.length) return reason ? { ...publicRecord(r), matchReason: reason } : publicRecord(r);
    const body = textFor(r);
    return { ...publicRecord(r, tokens), ...(reason ? { matchReason: reason } : {}), highlights: tokens.filter(t => body.includes(t)) };
  };
  const matches = available.filter(r => (scores.get(searchKey(r)) ?? 0) > 0).sort(opts.sort === 'recent' ? byRecent : byRelevance).map(annotate);
  const counts = Object.fromEntries([...SEARCH_TYPES, 'all'].map(t => [t, 0])) as SearchResponse['counts'];
  counts.all = matches.length;
  matches.forEach(r => counts[r.type]++);
  const filtered = matches.filter(r => !opts.type || opts.type === 'all' || r.type === opts.type);
  const results = filtered.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
  const visible = new Set(results.map(searchKey));
  // Related: one edge away from a visible result, read from the index (plus recordings' own edges).
  const relatedDocs = index && visible.size ? await index.neighbours(tenant, [...visible].filter(k => !k.startsWith('recording:'))) : [];
  const relatedEdges = relatedDocs.map(n => ({ id: n.edge.id, source: n.edge.source, target: n.edge.target, label: n.edge.label }));
  for (const n of relatedDocs) {
    const key = searchKey(n.doc as unknown as SearchRef);
    if (!records.has(key) && (n.doc.acl == null || allowedAcls.includes(n.doc.acl)) && (!opts.scope || scoped.has(key))) records.set(key, docRecord(n.doc));
  }
  const allEdges = [...new Map([...validEdges, ...relatedEdges].filter(e => records.has(e.source) && records.has(e.target)).map(e => [e.id, e])).values()];
  const neighbors = new Set<string>();
  allEdges.forEach(e => { if (visible.has(e.source)) neighbors.add(e.target); if (visible.has(e.target)) neighbors.add(e.source); });
  const related = [...records.values()].filter(r => neighbors.has(searchKey(r)) && !visible.has(searchKey(r)) && (!opts.scope || scoped.has(searchKey(r)))).slice(0, 100).map(r => (scores.get(searchKey(r)) ?? 0) > 0 ? annotate(r) : publicRecord(r));
  related.forEach(r => visible.add(searchKey(r)));
  // `total` is the requested type's match count — the same number its tab
  // badge shows — counted over the records the projection holds. Any partial
  // source makes it (and every count) a floor, and the response says so.
  const total = counts[!opts.type || opts.type === 'all' ? 'all' : opts.type];
  return { query: q, results, counts, total, totalIsLowerBound: partial.length > 0, related, edges: allEdges.filter(e => visible.has(e.source) && visible.has(e.target)), ...(partial.length ? { partial: [...new Set(partial)] } : {}) };
}

const initiative = (id: string): SearchRef => ({ type: 'initiative', id });
/** The words of a query with the stopwords out — the plain, intent-free search. */
function plainTerms(q: string): string[] { return [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(t => !STOPWORDS.has(t)); }
/** A projected doc as the result row it draws. */
function docRecord(d: SearchDoc): RecordingSearchRecord {
  return { ...(d.record as Omit<SearchRecord, 'type' | 'id' | 'title'>), type: d.type as SearchRecordType, id: d.id, title: d.title, ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}) };
}
/** The signed-in person for "my / me" (U6): through the directory, a clone resolving as its persona (lib/record-owner.ts via lib/mine.ts). */
async function viewerPersonId(principal: PrincipalRef): Promise<string | null> {
  try { return (await mineViewer(principal as Session)).personId; } catch { return null; }
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
      return d ? { ...ref, title: d.topic, description: d.summary ?? undefined, status: d.status, href: `/iq/decisions/${enc(d.id)}` } : null;
    }
    if (ref.type === 'knowledge') { const k = await getRunbookSearchEntry(ref.id); return k ? knowledgeRecord(k) : null; }
    if (ref.type === 'asset') { const a = await getAsset(ref.id); return a ? { ...ref, title: a.name, description: a.description, status: a.lifecycleStatus, href: `/iq/library/${enc(a.id)}` } : null; }
    if (ref.type === 'recording') return resolveRecordingSearchRecord(principal, ref.id);
    if (ref.type === 'team') {
      if (!allowed.people) return null;
      const team = await projectOrgiqRecord('orgiq', 'team', ref.id);
      return team ? docRecord(team) : null;
    }
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
      const k = await getRunbookSearchEntry(record.id);
      if (k?.initiative_id) link({ type: 'initiative', id: k.initiative_id }, record, 'scoped to');
    } else if (record.type === 'recording') {
      record.sourceRefs?.forEach(source => link(source, record, 'recorded artifacts'));
    }
  }));
  return { records, edges: [...new Map(edges.map(e => [e.id, e])).values()] };
}

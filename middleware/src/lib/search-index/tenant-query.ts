// One search for the four non-Work tenants (docs/user-search-goal.md S2, U7):
// the question is rewritten deterministically (scaffolding out, the tenant's
// phrase rules in, "my / me" bound to the reader), the projection is queried
// through the SearchIndex, candidates are filtered by ACL and by the tenant's
// own visibility rule, and the survivors are ranked. No model, no SQL.
//
// The palette (portal) is the main reader: rows come back shaped for its
// record section (type chip, title, subtitle, href).

import { recordUserId } from '../record-owner.js';
import { mineViewer } from '../mine.js';
import { isAllowed, type PrincipalRef } from '../authz.js';
import type { Session } from '../session.js';
import { ensureIndexed } from './registry.js';
import { STOPWORDS } from './question.js';
import { tenantSpec, type IndexedTenant, type TenantIndexSpec, type TenantSearchContext } from './tenants.js';
import { stem, words } from './tokens.js';
import type { SearchDoc } from './types.js';

/** Words that say what is wanted, not what it is about (every tenant). */
const SCAFFOLD = new Set(('find show open jump go goto take get give list tell search look lookup page pages record records '
  + 'all any every there here still currently now today').split(' '));

export interface ParsedTenantQuery {
  terms: string[];
  /** Types the phrase rules or type words narrowed the search to, or null. */
  types: string[] | null;
  facets: Record<string, string[]>;
  /** "my / me": a facet value asked for the reader (`@me` / `@person`). */
  mine: boolean;
  /** Types a bare type word named ("teams", "rooms") — they rank, and with no other term they list. */
  typeWords: string[];
}

const plural = (w: string) => (w.endsWith('s') ? w : `${w}s`);

/** The type words of a spec: its labels, singular and plural, lowercased ("team" -> team, "missed call" -> ...). */
function typeWordMap(spec: TenantIndexSpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const [type, label] of Object.entries(spec.labels)) {
    for (const w of words(label)) { out.set(w, type); out.set(plural(w), type); }
    out.set(type, type); out.set(plural(type), type);
  }
  return out;
}

export function parseTenantQuery(question: string, spec: TenantIndexSpec): ParsedTenantQuery {
  let q = ` ${question.toLowerCase().replace(/[’]/g, "'")} `;
  const facets: Record<string, string[]> = {};
  const extra: string[] = [];
  let types: string[] | null = null;
  let mine = false;
  for (const rule of spec.rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    if (!re.test(q)) continue;
    re.lastIndex = 0;
    q = q.replace(re, ' ');
    if (rule.types) types = types ? types.filter(t => rule.types!.includes(t)) : [...rule.types];
    for (const [name, values] of Object.entries(rule.facets ?? {})) {
      facets[name] = [...new Set([...(facets[name] ?? []), ...values])];
      if (values.some(v => v === '@me' || v === '@person')) mine = true;
    }
    if (rule.terms) extra.push(...rule.terms);
  }
  const typeMap = typeWordMap(spec);
  const scaffold = new Set([...SCAFFOLD, ...(spec.scaffold ?? [])]);
  const typeWords: string[] = [];
  const terms: string[] = [];
  for (const w of words(q.replace(/[#@]/g, ' '))) {
    if (STOPWORDS.has(w) || scaffold.has(w)) continue;
    const t = typeMap.get(w);
    if (t) { if (!typeWords.includes(t)) typeWords.push(t); continue; }
    if (!terms.includes(w)) terms.push(w);
  }
  for (const e of extra) if (!terms.includes(e)) terms.push(e);
  return { terms, types, facets, mine, typeWords };
}

export interface TenantSearchRow {
  type: string;
  id: string;
  title: string;
  kind: string;
  subtitle?: string;
  description?: string;
  status?: string;
  href: string;
  /** The source's own time (a message's, a call's start), when it has one: what "since yesterday" filters on. */
  updatedAt?: string;
  score: number;
}
export interface TenantSearchResponse { query: string; results: TenantSearchRow[]; counts: Record<string, number>; total: number; partial?: string[] }

const lower = (s: string) => s.toLowerCase();

function scoreDoc(doc: SearchDoc, parsed: ParsedTenantQuery): number {
  const title = lower(doc.title), body = lower(`${doc.title} ${doc.text} ${String(doc.record['subtitle'] ?? '')}`);
  // A term is found as written or as its plural-stripped stem ("transcripts" in "the transcription queue"), the
  // same keys the postings answered under (tokens.ts termKeys); the title bonuses below stay exact.
  const hits = parsed.terms.filter(t => body.includes(t) || body.includes(stem(t)));
  let s = 1;
  if (parsed.terms.length) {
    // Most of the words must be found: one word of five is a coincidence, not an answer.
    if (hits.length < Math.max(1, Math.ceil(parsed.terms.length * 0.5))) return 0;
    s = hits.length * 2 + parsed.terms.filter(t => title.includes(t)).length * 4 + (parsed.terms.every(t => title.includes(t)) ? 12 : 0);
    // "#design-reviews" is the title that the words "design reviews" spell out; a message that merely mentions it is not.
    if (title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === parsed.terms.join(' ')) s += 20;
  }
  if (parsed.typeWords.includes(doc.type)) s += 6;
  return s;
}

export async function tenantContext(tenant: IndexedTenant, principal: PrincipalRef, spec?: TenantIndexSpec): Promise<TenantSearchContext> {
  let personId: string | null = null;
  try { personId = (await mineViewer(principal as Session)).personId; } catch { personId = null; }
  const acls = spec?.acls ?? [];
  const allowedAcls: string[] = [];
  for (const a of acls) if (await isAllowed(principal, a)) allowedAcls.push(a);
  void tenant;
  return { principal, userId: recordUserId(principal.sub), personId, allowedAcls };
}

export async function searchTenant(tenant: Exclude<IndexedTenant, 'orgiq'>, principal: PrincipalRef, input: { q: string; limit?: number; type?: string }): Promise<TenantSearchResponse> {
  const spec = await tenantSpec(tenant);
  const [indexed, ctx] = await Promise.all([ensureIndexed(tenant), tenantContext(tenant, principal, spec)]);
  const { index, partition, meta } = indexed;
  const parsed = parseTenantQuery(input.q, spec);
  const limit = Math.max(1, Math.min(input.limit ?? 8, 50));
  const empty: TenantSearchResponse = { query: input.q, results: [], counts: {}, total: 0, ...(meta.partial.length ? { partial: meta.partial } : {}) };
  const types = input.type && input.type !== 'all' ? (parsed.types ? parsed.types.filter(t => t === input.type) : [input.type]) : parsed.types;
  // A bare type word ("rooms", "missed calls") lists that type when nothing else narrows the query.
  const listTypes = !parsed.terms.length && !types && parsed.typeWords.length ? parsed.typeWords : null;
  if (!parsed.terms.length && !types && !listTypes && !Object.keys(parsed.facets).length) return empty;
  // "my / me" resolves to the reader or to nothing — never to a guess.
  const facets: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(parsed.facets)) {
    const resolved = values.flatMap(v => v === '@me' ? (ctx.userId ? [ctx.userId] : []) : v === '@person' ? (ctx.personId ? [ctx.personId] : []) : [v]);
    if (!resolved.length) return empty;
    facets[name] = resolved;
  }
  const page = await index.query({
    tenant: partition, terms: parsed.terms, ...(types || listTypes ? { types: types ?? listTypes! } : {}),
    ...(Object.keys(facets).length ? { facets } : {}), allowedAcls: ctx.allowedAcls,
  });
  const rows = page.docs
    .filter(d => !spec.visible || spec.visible(d, ctx))
    .map(d => ({ d, score: scoreDoc(d, parsed) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || (b.d.updatedAt ?? '').localeCompare(a.d.updatedAt ?? '') || a.d.title.localeCompare(b.d.title));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.d.type] = (counts[r.d.type] ?? 0) + 1;
  const str = (d: SearchDoc, k: string) => (typeof d.record[k] === 'string' && d.record[k] ? { [k]: d.record[k] as string } : {});
  const results: TenantSearchRow[] = rows.slice(0, limit).map(({ d, score }) => ({
    type: d.type, id: d.id, title: d.title, kind: spec.labels[d.type] ?? d.type, href: String(d.record['href'] ?? ''),
    ...str(d, 'subtitle'), ...str(d, 'description'), ...str(d, 'status'), ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}), score,
  }));
  return { query: input.q, results, counts, total: rows.length, ...(meta.partial.length ? { partial: meta.partial } : {}) };
}

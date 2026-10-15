// The in-memory SearchIndex: dev:mock and tests. Same postings, facets and
// adjacency as the kv implementation (kv.ts), held in Maps per partition.

import { docTokens, facetValue, termKeys } from './tokens.js';
import {
  DEFAULT_QUERY_LIMIT, docKey, visibleTo,
  type DocKey, type IndexMeta, type Neighbour, type SearchDoc, type SearchDocEdge, type SearchIndex, type SearchIndexPage, type SearchIndexQuery,
} from './types.js';

interface Partition {
  docs: Map<DocKey, SearchDoc>;
  postings: Map<string, Set<DocKey>>;
  facets: Map<string, Set<DocKey>>;
  byType: Map<string, Set<DocKey>>;
  /** key → edge id → edge, for both ends of every edge a doc owns. */
  adjacency: Map<DocKey, Map<string, SearchDocEdge>>;
  meta: IndexMeta | null;
}

const add = <K, V>(map: Map<K, Set<V>>, k: K, v: V) => { let s = map.get(k); if (!s) { s = new Set(); map.set(k, s); } s.add(v); };
const drop = <K, V>(map: Map<K, Set<V>>, k: K, v: V) => { const s = map.get(k); if (!s) return; s.delete(v); if (!s.size) map.delete(k); };
const copy = (doc: SearchDoc): SearchDoc => structuredClone(doc);

export class MemorySearchIndex implements SearchIndex {
  readonly kind = 'memory' as const;
  private readonly parts = new Map<string, Partition>();

  private part(tenant: string): Partition {
    let p = this.parts.get(tenant);
    if (!p) {
      p = { docs: new Map(), postings: new Map(), facets: new Map(), byType: new Map(), adjacency: new Map(), meta: null };
      this.parts.set(tenant, p);
    }
    return p;
  }

  /** Partitions held, for pruning namespaces whose world is gone. */
  partitions(): string[] { return [...this.parts.keys()]; }

  private unindex(p: Partition, key: DocKey): void {
    const old = p.docs.get(key);
    if (!old) return;
    for (const t of docTokens(old.title, old.text)) drop(p.postings, t, key);
    for (const [name, values] of Object.entries(old.facets)) for (const v of values) drop(p.facets, `${name}=${facetValue(v)}`, key);
    drop(p.byType, old.type, key);
    for (const e of old.edges) {
      p.adjacency.get(e.source)?.delete(e.id);
      p.adjacency.get(e.target)?.delete(e.id);
    }
    p.docs.delete(key);
  }

  async put(doc: SearchDoc): Promise<void> {
    const p = this.part(doc.tenant);
    const key = docKey(doc.type, doc.id);
    this.unindex(p, key);
    const stored = copy(doc);
    p.docs.set(key, stored);
    for (const t of docTokens(stored.title, stored.text)) add(p.postings, t, key);
    for (const [name, values] of Object.entries(stored.facets)) for (const v of values) add(p.facets, `${name}=${facetValue(v)}`, key);
    add(p.byType, stored.type, key);
    for (const e of stored.edges) {
      for (const end of [e.source, e.target]) {
        let m = p.adjacency.get(end);
        if (!m) { m = new Map(); p.adjacency.set(end, m); }
        m.set(e.id, e);
      }
    }
  }

  async putMany(docs: SearchDoc[]): Promise<void> { for (const d of docs) await this.put(d); }

  async remove(tenant: string, key: DocKey): Promise<void> { this.unindex(this.part(tenant), key); }

  async get(tenant: string, keys: DocKey[]): Promise<SearchDoc[]> {
    const p = this.part(tenant);
    return keys.flatMap(k => { const d = p.docs.get(k); return d ? [copy(d)] : []; });
  }

  async query(q: SearchIndexQuery): Promise<SearchIndexPage> {
    const p = this.part(q.tenant);
    let keys: Set<DocKey>;
    if (q.terms.length) {
      keys = new Set();
      for (const term of q.terms) for (const k of termKeys(term)) for (const key of p.postings.get(k) ?? []) keys.add(key);
    } else if (q.types?.length) {
      keys = new Set(q.types.flatMap(t => [...(p.byType.get(t) ?? [])]));
    } else keys = new Set(p.docs.keys());
    for (const [name, values] of Object.entries(q.facets ?? {})) {
      const allowed = new Set(values.flatMap(v => [...(p.facets.get(`${name}=${facetValue(v)}`) ?? [])]));
      keys = new Set([...keys].filter(k => allowed.has(k)));
    }
    const docs = [...keys].sort()
      .map(k => p.docs.get(k)!)
      .filter(d => d && (!q.types?.length || q.types.includes(d.type)) && visibleTo(d, q.allowedAcls));
    const start = q.cursor ? Number(q.cursor) || 0 : 0;
    const limit = q.limit ?? DEFAULT_QUERY_LIMIT;
    const page = docs.slice(start, start + limit).map(copy);
    return { docs: page, cursor: start + limit < docs.length ? String(start + limit) : null };
  }

  async neighbours(tenant: string, keys: DocKey[], labels?: string[]): Promise<Neighbour[]> {
    const p = this.part(tenant);
    const out: Neighbour[] = [];
    for (const from of [...new Set(keys)]) {
      for (const edge of [...(p.adjacency.get(from)?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
        if (labels && !labels.includes(edge.label)) continue;
        const other = edge.source === from ? edge.target : edge.source;
        const doc = p.docs.get(other);
        if (doc) out.push({ from, edge: { ...edge }, doc: copy(doc) });
      }
    }
    return out;
  }

  async getMeta(tenant: string): Promise<IndexMeta | null> {
    const m = this.parts.get(tenant)?.meta;
    return m ? { ...m, partial: [...m.partial] } : null;
  }

  async setMeta(tenant: string, meta: IndexMeta): Promise<void> { this.part(tenant).meta = { ...meta, partial: [...meta.partial] }; }

  async clear(tenant: string): Promise<void> { this.parts.delete(tenant); }
}

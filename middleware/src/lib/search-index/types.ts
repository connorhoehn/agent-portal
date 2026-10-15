// The search projection's contract (docs/user-search-goal.md U1–U3).
//
// A SearchDoc is one searchable record as search sees it: the words it is
// found by, the facets it is filtered by, the people it involves, the edges
// that relate it to other records, and the display payload a result row draws.
// Providers own the records; the projection is rebuilt from them and updated
// after every write that changes a searchable field (lib/search-index/writes.ts).
//
// Storage-agnostic by construction: `SearchIndex` is implemented in memory
// (dev:mock, tests) and over the DynamoDB wire protocol (kv.ts — Query,
// BatchGet, BatchWrite and one GSI; no scans on the read path, no SQL). The
// judge (scripts/validate-user-search.sh) refuses an SQL client import or an
// SQL statement anywhere under this directory or providers/search*.

/** `type:id`, the same key search results and context selections use. */
export type DocKey = string;
export const docKey = (type: string, id: string): DocKey => `${type}:${id}`;
export function splitKey(key: DocKey): { type: string; id: string } {
  const colon = key.indexOf(':');
  return { type: key.slice(0, colon), id: key.slice(colon + 1) };
}

/** A relationship recorded on the doc that owns it; adjacency covers both ends. */
export interface SearchDocEdge {
  id: string;
  source: DocKey;
  target: DocKey;
  label: string;
  /** Strength where the source records one (collaboration weight). */
  weight?: number;
}

export interface SearchDoc {
  /** The partition: the tenant, plus a namespace suffix for an isolated world (a mock scope). */
  tenant: string;
  type: string;
  id: string;
  title: string;
  /** Everything the doc is found by besides its title (description, subtitle, skills…). */
  text: string;
  /** Exact-match filters: status, skill, department, assignee, decider… Values are lowercased by the index. */
  facets: Record<string, string[]>;
  /** Person ids the record involves (owner, assignee, members, deciders). */
  people: string[];
  edges: SearchDocEdge[];
  /** The Cedar action a reader needs beyond the route's own gate, or null. */
  acl: string | null;
  updatedAt: string | null;
  /** The result row's display fields (href, subtitle, status, avatarUrl, sourceRefs…). Never searched. */
  record: Record<string, unknown>;
}

export interface SearchIndexQuery {
  tenant: string;
  /** Query terms (already rewritten); a doc matching ANY term is a candidate. Empty = no text constraint. */
  terms: string[];
  types?: string[];
  /** AND across names, OR within one name's values. */
  facets?: Record<string, string[]>;
  /** Actions the reader holds; a doc whose `acl` is not among them is never returned. */
  allowedAcls?: string[];
  limit?: number;
  cursor?: string | null;
}

export interface SearchIndexPage {
  docs: SearchDoc[];
  cursor: string | null;
}

export interface Neighbour {
  /** The key whose neighbour this is. */
  from: DocKey;
  edge: SearchDocEdge;
  doc: SearchDoc;
}

/** Bookkeeping per partition: when it was built from the providers, and what was missing. */
export interface IndexMeta {
  builtAt: string;
  /** Sources that were windowed or unreadable at build time (search's `partial`). */
  partial: string[];
  /** Set when a source failed outright: the partition is rebuilt after this time. */
  retryAfter?: string | null;
}

export interface SearchIndex {
  readonly kind: 'memory' | 'kv';
  put(doc: SearchDoc): Promise<void>;
  putMany(docs: SearchDoc[]): Promise<void>;
  remove(tenant: string, key: DocKey): Promise<void>;
  get(tenant: string, keys: DocKey[]): Promise<SearchDoc[]>;
  query(q: SearchIndexQuery): Promise<SearchIndexPage>;
  /** Records one edge away from each key, optionally only through these labels. */
  neighbours(tenant: string, keys: DocKey[], labels?: string[]): Promise<Neighbour[]>;
  getMeta(tenant: string): Promise<IndexMeta | null>;
  setMeta(tenant: string, meta: IndexMeta): Promise<void>;
  /** Drop a partition (its docs, postings, facets, edges and meta). */
  clear(tenant: string): Promise<void>;
}

/** Default page size for a query; callers rank, so they ask for the whole candidate set. */
export const DEFAULT_QUERY_LIMIT = 5_000;

export function visibleTo(doc: SearchDoc, allowedAcls: string[] | undefined): boolean {
  return doc.acl == null || (allowedAcls ?? []).includes(doc.acl);
}

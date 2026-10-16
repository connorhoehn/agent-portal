// The per-tenant half of the search projection (docs/user-search-goal.md S2):
// what each tenant indexes, how its records are re-read after a write, which
// phrases mean a type or a facet, and who may see a candidate. orgiq keeps its
// own projection (./orgiq.ts); the other four tenants each export a
// `TenantIndexSpec` from ./<tenant>.ts, loaded on first use so the providers'
// import order is untouched.

import type { PrincipalRef } from '../authz.js';
import type { SearchDoc } from './types.js';

export type IndexedTenant = 'orgiq' | 'assessment' | 'social' | 'pipelines' | 'access';
export const INDEXED_TENANTS: readonly IndexedTenant[] = ['orgiq', 'assessment', 'social', 'pipelines', 'access'];
export const isIndexedTenant = (t: string): t is IndexedTenant => (INDEXED_TENANTS as readonly string[]).includes(t);

export interface TenantBuild {
  docs: SearchDoc[];
  /** Sources windowed or unreadable (search's `partial`). */
  partial: string[];
  /** True when a source failed outright: the build is retried. */
  failed: boolean;
}

/** Who is asking: the record-owner user id (a clone is its persona) and the directory's person link. */
export interface TenantSearchContext {
  principal: PrincipalRef;
  /** `recordUserId(session.sub)`: the user id records are keyed by. */
  userId: string;
  personId: string | null;
  /** The doc `acl` actions the reader holds. */
  allowedAcls: string[];
}

/**
 * A phrase that names a type or a facet instead of a word to find (U7). The
 * matched text is removed from the query; `@me` in a facet value is the
 * reader's `userId`, `@person` the reader's `personId` (no value = no answer,
 * never a guess).
 */
export interface PhraseRule {
  re: RegExp;
  types?: string[];
  facets?: Record<string, string[]>;
  /** Words to add to the query terms (a synonym: "white glove" -> the facet word the docs carry). */
  terms?: string[];
}

export interface TenantIndexSpec {
  tenant: Exclude<IndexedTenant, 'orgiq'>;
  /** Doc types this tenant projects. */
  types: readonly string[];
  /** type -> the chip a result row shows ("Team", "Channel"). Also the words that name the type in a query. */
  labels: Record<string, string>;
  /** Cedar actions a doc `acl` may name. */
  acls: readonly string[];
  /** Rebuild every record (partition = `<tenant>` plus a mock namespace). */
  build(partition: string): Promise<TenantBuild>;
  /** One record re-read after a write; null when it no longer exists or is not searchable. */
  project(partition: string, type: string, id: string): Promise<SearchDoc | null>;
  rules: PhraseRule[];
  /** A candidate beyond `acl` the reader must not see (a request's parties, a private channel's members). */
  visible?(doc: SearchDoc, ctx: TenantSearchContext): boolean;
  /** Extra words that never narrow a search in this tenant ("assessment", "channel"). */
  scaffold?: readonly string[];
}

export async function tenantSpec(tenant: Exclude<IndexedTenant, 'orgiq'>): Promise<TenantIndexSpec> {
  switch (tenant) {
    case 'assessment': return (await import('./assessment.js')).assessmentSpec;
    case 'social': return (await import('./social.js')).socialSpec;
    case 'pipelines': return (await import('./pipelines.js')).pipelinesSpec;
    case 'access': return (await import('./access.js')).accessSpec;
  }
}

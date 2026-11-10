// Who owns which part of the documents bucket.
//
// One Bedrock knowledge base indexes the whole documents bucket, and the read
// agents keep only the caller's tenant's documents
// (agents/_shared/kb_resolver.py). A document belongs to the tenant whose
// registered prefix is the longest one its key starts with. The home tenant's
// corpus (orgiq's, which predates the registry) used to be "every key no
// prefix matches", so registering a parent prefix of unregistered home
// documents took them over. Now the home corpus is registered explicitly here
// (the same list as kb_resolver.HOME_PREFIXES, checked by
// agents/tests/test_kb_tenant_filter.py), retrieval denies a key no prefix
// matches, and kb-admin refuses a prefix that overlaps another tenant's or
// already holds objects that are not the registering tenant's.

export const HOME_KB_TENANT = 'orgiq';

/**
 * Each tenant's declared corpus prefixes, registered by code rather than by
 * row: tenants/kb-prefixes.json (which the infra reads to create one
 * knowledge-base data source per prefix), copied here because the image does
 * not carry that file; lib/__tests__/kb-prefixes.test.ts and the agents'
 * test_kb_tenant_filter.py keep the copies equal.
 */
export const DECLARED_KB_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['orgiq/', 'synth/', 'uploads/', 'crawled/'],
  assessment: ['assessment/'],
};

/** The home tenant's corpus prefixes. */
export const HOME_KB_PREFIXES: readonly string[] = DECLARED_KB_PREFIXES[HOME_KB_TENANT]!;

/** The document metadata attribute naming the owning tenant (Bedrock `<key>.metadata.json`). */
export const TENANT_METADATA_KEY = 'tenant';

/** `a/b`, `a/b/`, ` a/b// ` → `a/b/`; empty, `/` or whitespace → `/`. */
export function normPrefix(p: string): string {
  return `${p.trim().replace(/^\/+/, '').replace(/\/+$/, '')}/`;
}

/** Whether one prefix is, contains, or sits inside the other (on whole segments). */
export function prefixesOverlap(a: string, b: string): boolean {
  const x = normPrefix(a);
  const y = normPrefix(b);
  return x.startsWith(y) || y.startsWith(x);
}

export interface TenantPrefix { tenant: string; s3Prefix: string }

/** Registered prefixes plus every tenant's declared corpus. */
export function withHomePrefixes(registered: readonly TenantPrefix[]): TenantPrefix[] {
  return [
    ...registered.filter((r) => r.s3Prefix.trim() !== ''),
    ...Object.entries(DECLARED_KB_PREFIXES).flatMap(([tenant, prefixes]) =>
      prefixes.map((s3Prefix) => ({ tenant, s3Prefix }))),
  ];
}

/**
 * The tenant that owns `key`: the longest registered or declared prefix it
 * starts with (the agents' kb_resolver.document_owner rule), or null.
 */
export function ownerOfKey(key: string, registered: readonly TenantPrefix[] = []): string | null {
  const k = key.replace(/^\/+/, '');
  let best = -1;
  let owner: string | null = null;
  for (const { tenant, s3Prefix } of withHomePrefixes(registered)) {
    const p = normPrefix(s3Prefix);
    if (p === '/') continue;
    if (k.startsWith(p) && p.length > best) { best = p.length; owner = tenant; }
  }
  return owner;
}

/**
 * The Bedrock metadata sidecar for a document: `<key>.metadata.json` naming
 * its owning tenant, which retrieval filters on (beside the key-prefix check).
 */
export function tenantMetadataSidecar(key: string, tenant: string): { key: string; body: string } {
  return {
    key: `${key}.metadata.json`,
    body: JSON.stringify({ metadataAttributes: { [TENANT_METADATA_KEY]: tenant } }),
  };
}

/** Whether `key` lies under one of `prefixes`. */
export function keyUnder(key: string, prefixes: readonly string[]): boolean {
  const k = key.replace(/^\/+/, '');
  return prefixes.some((p) => k.startsWith(normPrefix(p)));
}

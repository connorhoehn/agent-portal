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

/** The home tenant's corpus prefixes, registered by code rather than by row. */
export const HOME_KB_PREFIXES: readonly string[] = ['orgiq/', 'synth/', 'uploads/', 'crawled/'];

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

/** Registered prefixes plus the home tenant's declared corpus. */
export function withHomePrefixes(registered: readonly TenantPrefix[]): TenantPrefix[] {
  return [
    ...registered.filter((r) => r.s3Prefix.trim() !== ''),
    ...HOME_KB_PREFIXES.map((s3Prefix) => ({ tenant: HOME_KB_TENANT, s3Prefix })),
  ];
}

/** Whether `key` lies under one of `prefixes`. */
export function keyUnder(key: string, prefixes: readonly string[]): boolean {
  const k = key.replace(/^\/+/, '');
  return prefixes.some((p) => k.startsWith(normPrefix(p)));
}

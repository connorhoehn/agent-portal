/** Select audit routes without widening a user-supplied concrete URL. */
export function selectAuditRoutes<T extends { path: string; pattern?: string }>(routes: readonly T[], query: string): Array<T & { auditPreservePath?: boolean }> {
  // Non-URL filters are intentionally broad (e.g. "runs" matches list/detail).
  if (!query.startsWith('/')) return routes.filter(r => r.path.includes(query) || r.pattern?.includes(query));
  const requested = new URL(query, 'http://audit.local');
  const segments = requested.pathname.split('/');
  // An explicit inventory template selects that route family and lets the
  // existing resolver choose its seeded record. It is not a literal URL.
  if (segments.some(segment => segment.startsWith(':'))) return routes.filter(r => r.pattern === requested.pathname || r.path === requested.pathname);
  const samePath = routes.filter(r => new URL(r.path, 'http://audit.local').pathname === requested.pathname);
  const literal = samePath.find(r => new URL(r.path, 'http://audit.local').search === requested.search) ?? samePath[0];
  const parameterized = literal ?? routes.find(r => {
    if (!r.pattern) return false;
    const pattern = r.pattern.split('/');
    return pattern.length === segments.length && pattern.every((segment, index) => segment.startsWith(':') || segment === segments[index]);
  });
  // Unknown absolute paths select nothing: the runner fails empty coverage.
  // Never silently turn a miss into a broader prefix/substring sweep.
  return parameterized ? [{ ...parameterized, path: requested.pathname + requested.search, auditPreservePath: true }] : [];
}

/**
 * Documented route aliases: the only redirects the audit accepts. Each is an
 * `index`/`Navigate` in App.tsx (or a page-level redirect with no selection),
 * so the requested path is a door onto the target page, not a page of its own.
 * Anything else that redirects fails readiness, because a redirect cannot
 * certify the page that was asked for.
 */
export const AUDIT_ROUTE_ALIASES: ReadonlyArray<{ pattern: RegExp; target: string; why: string }> = [
  { pattern: /^\/pipelines$/, target: '/pipelines/runs', why: 'tenant root opens Runs' },
  { pattern: /^\/iq$/, target: '/iq/work', why: 'tenant root opens Work' },
  { pattern: /^\/assessment$/, target: '/assessment/teams', why: 'tenant root opens Teams' },
  { pattern: /^\/social$/, target: '/social/channels', why: 'tenant root opens Channels' },
  { pattern: /^\/access$/, target: '/access/requests', why: 'tenant root opens Requests' },
  { pattern: /^\/admin\/identity$/, target: '/admin/identity/roles', why: 'section index opens Roles' },
  { pattern: /^\/admin\/observability$/, target: '/admin/observability/summary', why: 'section index opens Summary' },
  { pattern: /^\/iq\/scores\/compare$/, target: '/iq/scores', why: 'a comparison with no selected people returns to Scores (ScoresComparePage)' },
];
export function auditAliasTarget(pathname: string): string {
  return AUDIT_ROUTE_ALIASES.find(a => a.pattern.test(pathname))?.target ?? pathname;
}

/** Preserve the requested view/selection while allowing unrelated app-added parameters. */
export function matchesAuditLocation(requestedPath: string, actualURL: string): boolean {
  const requested = new URL(requestedPath, 'http://audit.local');
  const actual = new URL(actualURL, 'http://audit.local');
  const expectedPath = auditAliasTarget(requested.pathname);
  if (actual.pathname !== expectedPath) return false;
  return [...new Set(requested.searchParams.keys())].every(key => {
    const expected = requested.searchParams.getAll(key);
    const values = actual.searchParams.getAll(key);
    return expected.length === values.length && expected.every((value, index) => value === values[index]);
  });
}

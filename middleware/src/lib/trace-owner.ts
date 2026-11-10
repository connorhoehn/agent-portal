// Whose X-Ray traces a caller may list or open (GET /api/observability/traces
// and /traces/:traceId): the same scope as lib/trace-scope.ts applies to
// invocation_traces, over a trace's owner. No runtime imports, so the
// CloudWatch provider can apply it to its own read without an import cycle.

import type { TraceScope } from './trace-scope.js';

/**
 * An X-Ray trace (GET /api/observability/traces and /traces/:id) in the
 * caller's scope. Its owner is the root segment's `user_id` / `tenant`
 * annotations (the mock's own fields offline). Unlike the offline corpus a
 * trace needs BOTH: an ownerless trace, or one with no tenant, is the
 * cross-tenant admin's alone, so nobody else learns that it exists, not even
 * its name or token counts.
 */
export function traceInScope(scope: TraceScope | null, trace: { userId?: string | null; tenant?: string | null }): boolean {
  if (!scope) return true;
  if (!trace.userId || !trace.tenant) return false;
  if (scope.userId !== null && trace.userId !== scope.userId) return false;
  return trace.tenant === scope.tenant;
}

/** Annotation values X-Ray's filter language can quote safely; anything else matches nothing. */
const XRAY_VALUE = /^[A-Za-z0-9_.@:-]{1,128}$/;

/**
 * The X-Ray `FilterExpression` for the caller's scope (GetTraceSummaries), so
 * the read asks only for the caller's traces: undefined for the cross-tenant
 * admin, null when the scope cannot be expressed safely (read nothing).
 */
export function xrayScopeFilter(scope: TraceScope | null): string | undefined | null {
  if (!scope) return undefined;
  if (!XRAY_VALUE.test(scope.tenant) || (scope.userId !== null && !XRAY_VALUE.test(scope.userId))) return null;
  const tenant = `annotation.tenant = "${scope.tenant}"`;
  return scope.userId === null ? tenant : `annotation.user_id = "${scope.userId}" AND ${tenant}`;
}

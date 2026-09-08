// Route ↔ test parity, for every router — not just assessment.ts.
//
// `scripts/validate-assessment-tenant.sh` has carried this exact idea for one
// router for months and repeatedly caught real gaps: a route nothing calls is
// a route nobody has seen work. This generalizes it to the whole surface
// `wire/routes.ts` already enumerates (`src/index.ts` and everything it
// mounts, 440 routes at the time this was written), matched against every
// `request(...).<method>(path)` call in the test suite (`testCalls.ts`).
//
// MATCHING. A route and a call match when they have the same method, the
// same number of `/`-segments, and every segment pair agrees — where a route
// `:param` segment or a call's templated segment counts as agreeing with
// anything. See `testCalls.ts`'s header for exactly what "agreeing" misses.

import { enumerateRoutes, routeKey, type RouteRecord } from '../wire/routes.js';
import { collectTestCalls, type PathSegment, type TestCall } from './testCalls.js';

export interface CoverageRow {
  route: RouteRecord;
  tested: boolean;
  /** `src/routes/bots.ts` — the route's own source file, no line. */
  router: string;
}

function routeSegments(path: string): PathSegment[] {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((p) => (p.startsWith(':') ? ({ kind: 'wildcard' } as const) : ({ kind: 'literal', value: p } as const)));
}

function segmentsMatch(a: PathSegment[], b: PathSegment[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i]!;
    if (seg.kind === 'wildcard' || other.kind === 'wildcard') return true;
    return seg.value === other.value;
  });
}

export function routerOf(route: RouteRecord): string {
  return route.source.split(':')[0]!;
}

export function computeCoverage(routes: RouteRecord[], calls: TestCall[]): CoverageRow[] {
  return routes.map((route) => {
    const segs = routeSegments(route.path);
    const tested = calls.some((c) => c.method === route.method && segmentsMatch(segs, c.segments));
    return { route, tested, router: routerOf(route) };
  });
}

export interface CoverageReport {
  rows: CoverageRow[];
  untested: CoverageRow[];
  /** Untested routes grouped by router, each list worst-router-first is up to the caller. */
  byRouter: Map<string, CoverageRow[]>;
}

export function scanCoverage(): CoverageReport {
  const { routes } = enumerateRoutes();
  const calls = collectTestCalls();
  const rows = computeCoverage(routes, calls);
  const untested = rows.filter((r) => !r.tested);
  const byRouter = new Map<string, CoverageRow[]>();
  for (const row of untested) {
    const list = byRouter.get(row.router) ?? [];
    list.push(row);
    byRouter.set(row.router, list);
  }
  return { rows, untested, byRouter };
}

/** Routers ranked by untested-route count, worst first. */
export function rankedRouters(report: CoverageReport): Array<{ router: string; count: number; routes: CoverageRow[] }> {
  return [...report.byRouter.entries()]
    .map(([router, routes]) => ({ router, count: routes.length, routes }))
    .sort((a, b) => b.count - a.count || a.router.localeCompare(b.router));
}

export { routeKey };

/** One ranked, readable report — the deliverable, not just the number. */
export function formatReport(report: CoverageReport): string {
  const lines: string[] = [
    `route coverage: ${report.rows.length - report.untested.length}/${report.rows.length} routes have a matching request(...) call`,
    '',
  ];
  for (const { router, count, routes } of rankedRouters(report)) {
    lines.push(`${router} — ${count} untested`);
    for (const row of routes) {
      lines.push(`    ${row.route.method.padEnd(6)} ${row.route.path}  (${row.route.source})`);
    }
  }
  return lines.join('\n');
}

// `npx tsx src/mock/core/coverage/scan.ts` — the same report the validator
// script reads, on demand.
if (process.argv[1]?.endsWith('coverage/scan.ts')) {
  const report = scanCoverage();
  console.log(formatReport(report));
  console.log(`\nTOTAL_UNTESTED=${report.untested.length}`);
}

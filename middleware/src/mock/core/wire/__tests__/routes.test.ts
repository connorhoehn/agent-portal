// The route table must be enumerated, and the snapshot must keep up with it.
//
// This is the test that makes "a new route is covered the day it ships" true:
// `enumerateRoutes()` reads the routers, `snapshots/routes.json` records what
// was last captured, and a route in one and not the other fails here by name.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { snapshotDir, ROUTES_SNAPSHOT } from '../paths.js';
import { enumerateRoutes, routeKey, pathParams, type RouteRecord } from '../routes.js';

const snapshot = JSON.parse(
  readFileSync(join(snapshotDir(), ROUTES_SNAPSHOT), 'utf8'),
) as { routes: RouteRecord[]; unresolved: Array<{ reason: string; source: string }> };

describe('route enumeration', () => {
  const live = enumerateRoutes();

  it('finds the whole surface, not a sample', () => {
    // A parser that silently stopped following mounts would still "pass" a
    // subset check, so pin the order of magnitude.
    expect(live.routes.length).toBeGreaterThan(300);
    expect(live.routes.filter((r) => r.method === 'GET').length).toBeGreaterThan(150);
  });

  it('lists each method and path once, even when a module hosts two routers', () => {
    // agent-loop.ts and conversation-artifact.ts each export a social and a
    // tenant router; a mount names one, so none of them is attributed twice.
    const keys = live.routes.map(routeKey);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('follows a nested router mount', () => {
    // observability.ts does `observabilityRouter.use('/drift', driftRouter)`,
    // so a walker that only read index.ts would miss these entirely.
    const paths = live.routes.map((r) => r.path);
    expect(paths).toContain('/api/observability/drift/summary');
  });

  it('joins the mount prefix onto the router path', () => {
    const keys = live.routes.map(routeKey);
    expect(keys).toContain('GET /api/assessment/knowledge/tree');
    expect(keys).toContain('GET /health');
  });

  it('keeps params spelled, so a capture knows what it must fill', () => {
    expect(pathParams('/api/assessment/teams/:id/stories/:file')).toEqual(['id', 'file']);
  });

  it('resolves every mount — a dynamic one would shrink the surface silently', () => {
    expect(live.unresolved).toEqual([]);
  });

  it('agrees with the committed snapshot', () => {
    const liveKeys = new Set(live.routes.map(routeKey));
    const snapKeys = new Set(snapshot.routes.map(routeKey));
    const added = [...liveKeys].filter((k) => !snapKeys.has(k)).sort();
    const removed = [...snapKeys].filter((k) => !liveKeys.has(k)).sort();

    const problem = [
      added.length > 0 ? `${added.length} route(s) exist but were never captured:\n  ${added.join('\n  ')}` : '',
      removed.length > 0 ? `${removed.length} captured route(s) no longer exist:\n  ${removed.join('\n  ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (problem) {
      throw new Error(
        `${problem}\n\nRegenerate the snapshot — see middleware/src/mock/core/contract.ts, "Wire capture":\n` +
          '  cd middleware && npm run dev:mock            # one terminal\n' +
          '  cd middleware && npx tsx src/mock/core/wire/capture.ts',
      );
    }
  });
});
